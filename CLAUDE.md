# CLAUDE.md

## Project overview

`lg-input-switch` is a single-file Python CLI (`lg_switch.py`) that switches the active input on an **LG 45GX950A-B** monitor on Windows with an NVIDIA GPU.

## Why this exists

The LG 45GX950A-B silently ignores standard DDC/CI input-switch commands because LG firmware requires source address `0x50` in the I2C packet, while the Windows DDC/CI API hardcodes `0x51` with no override. This breaks every standard tool (ControlMyMonitor, Twinkle Tray, etc.).

The fix: bypass Windows DDC/CI entirely and write the raw I2C packet via **NVAPI** (`NvAPI_I2CWrite`), which exposes the physical I2C bus on NVIDIA GPUs.

Two LG quirks exploited:
- Source address must be `0x50` (not `0x51`)
- Uses proprietary VCP code `0xF4` (not the standard `0xF4` … actually `0x60`)

## Key technical details

### DDC/CI packet format
```
[0x50, 0x84, 0x03, 0xF4, value_hi, value_lo, checksum]
```
Checksum = XOR of `DDC_DEVICE_ADDR` (0x6E) and all preceding bytes.

### Input values (VCP code 0xF4)
| Value | Input |
|-------|-------|
| `0xD0` | DisplayPort |
| `0xD1` | USB-C / Thunderbolt |
| `0x90` | HDMI 1 |
| `0x91` | HDMI 2 |

### NVAPI function IDs (resolved via `nvapi_QueryInterface`)
| Function | ID |
|----------|----|
| `NvAPI_Initialize` | `0x0150E828` |
| `NvAPI_EnumPhysicalGPUs` | `0xE5AC921F` |
| `NvAPI_GPU_GetConnectedOutputs` | `0x1730BFC9` |
| `NvAPI_I2CWrite` | `0xE812EB07` |

### `NV_I2C_INFO` struct layout
64-bit Windows aligns the first pointer at offset 16. There are 6 bytes of explicit padding after `i2cDevAddress` (`_pad`) and 4 bytes after `regAddrSize` (`_pad2`) to match the NVIDIA SDK header.

## Code structure

All logic lives in `lg_switch.py` (~275 lines, no dependencies beyond stdlib):

- `INPUTS` — input name → (value, label) mapping
- `_build_setvcp()` — constructs the raw DDC/CI SetVCP packet
- `_NV_I2C_INFO` — ctypes struct matching NVIDIA SDK layout
- `_load_nvapi()` — loads `nvapi64.dll`
- `_resolve()` — resolves NVAPI function pointers via `nvapi_QueryInterface`
- `_nvapi_setup()` — initialises NVAPI, enumerates GPUs, gets connected output masks
- `_i2c_write()` — iterates output masks and port IDs, sends packet, returns True on first success
- `main()` — CLI entry point via argparse

### Stream Deck plugin (`streamdeck/`)

`streamdeck/io.github.retrohazard.lg-input-switch.sdPlugin/` is a Node.js Stream Deck plugin (SDK v3, Node 24, plain ESM JS, no build step):

- `bin/nvapi.js` — JS port of the NVAPI I2C path via `koffi`. **Keep `INPUTS`, the packet layout, function IDs, `NV_I2C_INFO` layout and the mask/port loop in sync with `lg_switch.py`.**
- `bin/plugin.js` — `Switch Input` and `Toggle Inputs` actions
- `ui/` — property inspectors (vendored `sdpi-components.js` v4)
- `.npmrc` pins `os=win32`/`cpu=x64` so `npm install` from WSL fetches the Windows koffi binary
- Validate/pack: `npx @elgato/cli validate|pack <dir>`; the plugin `Icon` must be PNG, other images may be SVG

## Development constraints

- **Windows only** — uses `ctypes.WinDLL`, `nvapi64.dll`, and Windows-specific kernel32 APIs
- **No pip packages** — stdlib only (`argparse`, `ctypes`, `sys`)
- **Python 3.10+** — uses `list[int]` PEP 585 type hints
- **NVIDIA GPU required** — NVAPI is NVIDIA-specific; no AMD/Intel path

## Running / testing

```
python lg_switch.py scan          # verify monitor is detected
python lg_switch.py dp            # switch to DisplayPort
python lg_switch.py --verbose dp  # debug output
```

`scan` mode is the safe diagnostic that doesn't switch anything — use it first to confirm the GPU sees the monitor on its I2C bus.

## Troubleshooting context

- `err -1` on all attempts → monitor not on I2C bus (check cable/port, try `scan`)
- `nvapi64.dll` not found → NVIDIA drivers missing or not on PATH
- Silent no-op → DDC/CI disabled in monitor OSD
