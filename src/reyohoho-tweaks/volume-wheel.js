const VOLUME_SLIDER_SELECTOR = '.volume-slider__slider-container';
const VOLUME_INPUT_SELECTOR = '[data-a-target="player-volume-slider"]';

const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

// Scrolling over the volume controls (mute button and slider) always changes the volume, unlike FFZ's
// player.volume-scroll which is off by default and covers the whole player
export default class VolumeWheel {
	constructor(addon) {
		this.addon = addon;
		this.enabled = false;
		this.Slider = addon.elemental.define('rte-volume-slider', VOLUME_SLIDER_SELECTOR, null, null, 0);
		this.handleWheel = this.handleWheel.bind(this);
		this.attach = slider => slider.parentElement?.addEventListener('wheel', this.handleWheel, {passive: false});
	}

	update() {
		const enabled = this.addon.active;
		if (enabled === this.enabled)
			return;
		this.enabled = enabled;

		if (enabled) {
			this.Slider.on('mount', this.attach);
			this.Slider.each(this.attach);
			return;
		}

		this.Slider.off('mount', this.attach);
		this.Slider.each(slider => slider.parentElement?.removeEventListener('wheel', this.handleWheel));
	}

	// Drive the slider like a drag would, so Twitch persists the volume, unmutes and shows its percent tooltip
	handleWheel(event) {
		const input = event.currentTarget.querySelector(VOLUME_INPUT_SELECTOR);
		if (input == null || input.disabled)
			return;

		const step = this.addon.settings.get('player.volume-scroll-steps');
		const value = parseFloat(input.value) + (event.deltaY > 0 ? -step : step);
		setInputValue.call(input, String(Math.min(Math.max(value, 0), 1)));
		input.dispatchEvent(new Event('input', {bubbles: true}));

		// Also keeps FFZ's whole-player scroll handler from changing the volume a second time
		event.preventDefault();
		event.stopPropagation();
	}
}
