import streamDeck, { SingletonAction } from "@elgato/streamdeck";

import { INPUTS, switchInput } from "./nvapi.js";

const PLUGIN = "io.github.retrohazard.lg-input-switch";
const log = streamDeck.logger;

function trySwitch(input) {
	try {
		const ok = switchInput(input);
		if (ok) log.info(`switched to ${input}`);
		else log.warn(`no I2C write accepted for ${input}`);
		return ok;
	} catch (err) {
		log.error(`switch to ${input} failed: ${err.message}`);
		return false;
	}
}

const shortLabel = (input) => INPUTS[input]?.short ?? "?";

/** One key, one input. */
class SwitchInputAction extends SingletonAction {
	manifestId = `${PLUGIN}.switch`;

	onWillAppear(ev) {
		return ev.action.setTitle(shortLabel(ev.payload.settings.input ?? "dp"));
	}

	onDidReceiveSettings(ev) {
		return ev.action.setTitle(shortLabel(ev.payload.settings.input ?? "dp"));
	}

	async onKeyDown(ev) {
		const input = ev.payload.settings.input ?? "dp";
		await (trySwitch(input) ? ev.action.showOk() : ev.action.showAlert());
	}
}

/**
 * One key, two inputs. The key remembers which input it last switched to and
 * shows it; state 0 = input A, state 1 = input B.
 */
class ToggleInputsAction extends SingletonAction {
	manifestId = `${PLUGIN}.toggle`;

	static resolve(settings) {
		const a = settings.inputA ?? "dp";
		const b = settings.inputB ?? "hdmi1";
		const current = settings.current === b ? b : a;
		return { a, b, current };
	}

	static async render(action, { a, current }) {
		await action.setState(current === a ? 0 : 1);
		await action.setTitle(shortLabel(current));
	}

	onWillAppear(ev) {
		return ToggleInputsAction.render(ev.action, ToggleInputsAction.resolve(ev.payload.settings));
	}

	onDidReceiveSettings(ev) {
		return ToggleInputsAction.render(ev.action, ToggleInputsAction.resolve(ev.payload.settings));
	}

	async onKeyDown(ev) {
		const s = ToggleInputsAction.resolve(ev.payload.settings);
		const target = s.current === s.a ? s.b : s.a;
		if (!trySwitch(target)) {
			await ev.action.showAlert();
			return;
		}
		await ev.action.setSettings({ ...ev.payload.settings, current: target });
		await ToggleInputsAction.render(ev.action, { ...s, current: target });
	}
}

streamDeck.actions.registerAction(new SwitchInputAction());
streamDeck.actions.registerAction(new ToggleInputsAction());
streamDeck.connect();
