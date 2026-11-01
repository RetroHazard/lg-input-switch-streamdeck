// Raw DDC/CI over NVAPI I2C, ported from lg_switch.py.
//
// LG monitors ignore input-switch commands sent through the Windows DDC/CI API
// because it hardcodes source address 0x51; LG firmware wants 0x50 with the
// proprietary VCP code 0xF4. NvAPI_I2CWrite lets us put any bytes on the wire.
//
// Keep packet layout, function IDs, struct layout and the mask/port loop in
// sync with lg_switch.py.

import koffi from "koffi";

export const INPUTS = {
	dp: { value: 0xd0, label: "DisplayPort", short: "DP" },
	hdmi1: { value: 0x90, label: "HDMI 1", short: "HDMI 1" },
	hdmi2: { value: 0x91, label: "HDMI 2", short: "HDMI 2" },
	usbc: { value: 0xd1, label: "USB-C / Thunderbolt", short: "USB-C" },
};

const INPUT_SOURCE_ADDR = 0x50;
const INPUT_VCP_CODE = 0xf4;
const DDC_DEVICE_ADDR = 0x6e;
const NVAPI_OK = 0;
const NVAPI_MAX_GPUS = 64;

const ID_INITIALIZE = 0x0150e828;
const ID_ENUM_PHYSICAL_GPUS = 0xe5ac921f;
const ID_GET_CONNECTED_OUTPUTS = 0x1730bfc9;
const ID_I2C_WRITE = 0xe812eb07;

// NV_I2C_INFO_V3, natural x64 alignment: pointers at 16 and 32, size 64.
const NV_I2C_INFO = koffi.struct("NV_I2C_INFO", {
	version: "uint32_t",
	displayMask: "uint32_t",
	bIsDDCPort: "uint8_t",
	i2cDevAddress: "uint8_t",
	pbI2cRegAddress: "uint8_t *",
	regAddrSize: "uint32_t",
	pbData: "uint8_t *",
	cbSize: "uint32_t",
	i2cSpeed: "uint32_t",
	i2cSpeedKhz: "uint32_t",
	portId: "uint8_t",
	bIsPortIdSet: "uint32_t",
});
if (koffi.sizeof(NV_I2C_INFO) !== 64) {
	throw new Error(`NV_I2C_INFO is ${koffi.sizeof(NV_I2C_INFO)} bytes, expected 64`);
}
const NV_I2C_VER3 = (3 << 16) | koffi.sizeof(NV_I2C_INFO);

const Initialize = koffi.proto("int NvAPI_Initialize()");
const EnumPhysicalGPUs = koffi.proto("int NvAPI_EnumPhysicalGPUs(_Out_ void **handles, _Out_ uint32_t *count)");
const GetConnectedOutputs = koffi.proto("int NvAPI_GPU_GetConnectedOutputs(void *gpu, _Out_ uint32_t *mask)");
const I2CWrite = koffi.proto("int NvAPI_I2CWrite(void *gpu, NV_I2C_INFO *info)");

/** Builds a DDC/CI SetVCP packet: [src, len, opcode, vcp, hi, lo, checksum]. */
export function buildSetVcp(sourceAddr, vcpCode, value) {
	const pkt = [sourceAddr, 0x84, 0x03, vcpCode, (value >> 8) & 0xff, value & 0xff];
	pkt.push(pkt.reduce((sum, b) => sum ^ b, DDC_DEVICE_ADDR));
	return Uint8Array.from(pkt);
}

let api = null;

function loadApi() {
	if (api) return api;
	const lib = koffi.load("nvapi64.dll");
	const queryInterface = lib.func("void *nvapi_QueryInterface(uint32_t id)");
	const resolve = (id, proto) => {
		const ptr = queryInterface(id);
		if (!ptr) throw new Error(`nvapi_QueryInterface returned NULL for 0x${id.toString(16)}`);
		return koffi.decode(ptr, proto);
	};

	const init = resolve(ID_INITIALIZE, Initialize);
	const ret = init();
	if (ret !== NVAPI_OK) throw new Error(`NvAPI_Initialize failed (${ret})`);

	const enumGpus = resolve(ID_ENUM_PHYSICAL_GPUS, EnumPhysicalGPUs);
	const handles = new Array(NVAPI_MAX_GPUS).fill(null);
	const count = [0];
	if (enumGpus(handles, count) !== NVAPI_OK || count[0] === 0) throw new Error("no NVIDIA GPUs found");

	api = {
		gpu: handles[0],
		getConnectedOutputs: resolve(ID_GET_CONNECTED_OUTPUTS, GetConnectedOutputs),
		i2cWrite: resolve(ID_I2C_WRITE, I2CWrite),
	};
	return api;
}

/** Returns the GPU 0 display output masks, one bit per connected display. */
export function connectedOutputs() {
	const { gpu, getConnectedOutputs } = loadApi();
	const mask = [0];
	const ret = getConnectedOutputs(gpu, mask);
	if (ret !== NVAPI_OK || mask[0] === 0) {
		// Same fallback as lg_switch.py: probe the first 8 outputs.
		return Array.from({ length: 8 }, (_, i) => 1 << i);
	}
	const masks = [];
	for (let i = 0; i < 32; i++) {
		if (mask[0] & (1 << i)) masks.push((1 << i) >>> 0);
	}
	return masks;
}

/**
 * Sends the packet to every connected display on every port ID, like
 * lg_switch.py. Returns true if any write was accepted by the GPU; the monitor
 * itself never acknowledges.
 */
export function i2cWrite(packet) {
	const { gpu, i2cWrite: write } = loadApi();
	let success = false;
	for (const displayMask of connectedOutputs()) {
		for (let portId = 0; portId < 8; portId++) {
			const ret = write(gpu, {
				version: NV_I2C_VER3,
				displayMask,
				bIsDDCPort: 1,
				i2cDevAddress: DDC_DEVICE_ADDR,
				pbI2cRegAddress: null,
				regAddrSize: 0,
				pbData: packet,
				cbSize: packet.length,
				i2cSpeed: 0xffff,
				i2cSpeedKhz: 0,
				portId,
				bIsPortIdSet: portId === 0 ? 0 : 1,
			});
			if (ret === NVAPI_OK) success = true;
		}
	}
	return success;
}

/** Switches every LG monitor on GPU 0 to the named input. */
export function switchInput(input) {
	const entry = INPUTS[input];
	if (!entry) throw new Error(`unknown input '${input}'`);
	return i2cWrite(buildSetVcp(INPUT_SOURCE_ADDR, INPUT_VCP_CODE, entry.value));
}
