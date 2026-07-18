import { describe, it, expect } from 'vitest';
import { HomeAssistant } from './services.js';

const target = { entity_id: 'light.kitchen_light_ceiling' };

// ---------- light ----------

describe('HomeAssistant.light', () => {
  it('turn_on emits correct domain/service/target', () => {
    expect(HomeAssistant.light.turn_on(target)).toMatchObject({
      type: 'ha.call_service', domain: 'light', service: 'turn_on', target,
    });
  });

  it('turn_on with data includes data in action', () => {
    const action = HomeAssistant.light.turn_on(target, { brightness_pct: 80, color_temp_kelvin: 4000 });
    expect(action).toMatchObject({ data: { brightness_pct: 80, color_temp_kelvin: 4000 } });
  });

  it('turn_on without data omits data field', () => {
    const action = HomeAssistant.light.turn_on(target);
    expect(action).not.toHaveProperty('data');
  });

  it('turn_off emits correct service', () => {
    expect(HomeAssistant.light.turn_off(target)).toMatchObject({ domain: 'light', service: 'turn_off' });
  });

  it('toggle emits correct service', () => {
    expect(HomeAssistant.light.toggle(target)).toMatchObject({ domain: 'light', service: 'toggle' });
  });
});

// ---------- switch ----------

describe('HomeAssistant.switch', () => {
  const sw = { entity_id: 'switch.foreign_office_plug_heater' };

  it('turn_on omits data field', () => {
    const action = HomeAssistant.switch.turn_on(sw);
    expect(action).toMatchObject({ domain: 'switch', service: 'turn_on', target: sw });
    expect(action).not.toHaveProperty('data');
  });

  it('turn_off emits correct action', () => {
    expect(HomeAssistant.switch.turn_off(sw)).toMatchObject({ domain: 'switch', service: 'turn_off', target: sw });
  });

  it('toggle emits correct action', () => {
    expect(HomeAssistant.switch.toggle(sw)).toMatchObject({ domain: 'switch', service: 'toggle' });
  });
});

// ---------- climate ----------

describe('HomeAssistant.climate', () => {
  const trv = { entity_id: 'climate.bedroom_trv' };

  it('set_temperature includes target and data', () => {
    const action = HomeAssistant.climate.set_temperature(trv, { temperature: 20, hvac_mode: 'heat' });
    expect(action).toMatchObject({ domain: 'climate', service: 'set_temperature', target: trv, data: { temperature: 20, hvac_mode: 'heat' } });
  });

  it('set_hvac_mode includes hvac_mode in data', () => {
    const action = HomeAssistant.climate.set_hvac_mode(trv, { hvac_mode: 'off' });
    expect(action).toMatchObject({ domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: 'off' } });
  });

  it('turn_on and turn_off have no data', () => {
    expect(HomeAssistant.climate.turn_on(trv)).not.toHaveProperty('data');
    expect(HomeAssistant.climate.turn_off(trv)).not.toHaveProperty('data');
  });
});

// ---------- cover ----------

describe('HomeAssistant.cover', () => {
  const blind = { entity_id: 'cover.parlour_blind' };

  it('open_cover has no data', () => {
    const action = HomeAssistant.cover.open_cover(blind);
    expect(action).toMatchObject({ domain: 'cover', service: 'open_cover', target: blind });
    expect(action).not.toHaveProperty('data');
  });

  it('set_cover_position includes position in data', () => {
    const action = HomeAssistant.cover.set_cover_position(blind, { position: 50 });
    expect(action).toMatchObject({ domain: 'cover', service: 'set_cover_position', data: { position: 50 } });
  });
});

// ---------- fan ----------

describe('HomeAssistant.fan', () => {
  const fan = { entity_id: 'fan.bedroom_fan' };

  it('turn_on without data has no data field', () => {
    expect(HomeAssistant.fan.turn_on(fan)).not.toHaveProperty('data');
  });

  it('turn_on with percentage includes data', () => {
    expect(HomeAssistant.fan.turn_on(fan, { percentage: 50 })).toMatchObject({ data: { percentage: 50 } });
  });

  it('set_percentage includes data', () => {
    expect(HomeAssistant.fan.set_percentage(fan, { percentage: 75 })).toMatchObject({ domain: 'fan', service: 'set_percentage', data: { percentage: 75 } });
  });
});

// ---------- lock ----------

describe('HomeAssistant.lock', () => {
  const lock = { entity_id: 'lock.front_door' };

  it('lock without code has no data', () => {
    expect(HomeAssistant.lock.lock(lock)).not.toHaveProperty('data');
  });

  it('unlock with code includes code in data', () => {
    expect(HomeAssistant.lock.unlock(lock, { code: '1234' })).toMatchObject({ data: { code: '1234' } });
  });
});

// ---------- media_player ----------

describe('HomeAssistant.media_player', () => {
  const player = { entity_id: 'media_player.kitchen_sonos' };

  it('media_play has no data', () => {
    expect(HomeAssistant.media_player.media_play(player)).not.toHaveProperty('data');
  });

  it('volume_set includes volume_level', () => {
    expect(HomeAssistant.media_player.volume_set(player, { volume_level: 0.5 })).toMatchObject({ data: { volume_level: 0.5 } });
  });

  it('play_media includes content id and type', () => {
    const action = HomeAssistant.media_player.play_media(player, { media_content_id: 'spotify:track:123', media_content_type: 'music' });
    expect(action).toMatchObject({ data: { media_content_id: 'spotify:track:123', media_content_type: 'music' } });
  });
});

// ---------- scene ----------

describe('HomeAssistant.scene', () => {
  const scene = { entity_id: 'scene.parlour_daylight' };

  it('turn_on without data has no data', () => {
    expect(HomeAssistant.scene.turn_on(scene)).not.toHaveProperty('data');
  });

  it('turn_on with transition includes data', () => {
    expect(HomeAssistant.scene.turn_on(scene, { transition: 0.5 })).toMatchObject({ data: { transition: 0.5 } });
  });
});

// ---------- input_boolean ----------

describe('HomeAssistant.input_boolean', () => {
  const helper = { entity_id: 'input_boolean.house_heating_enabled' };

  it('turn_on has no data', () => {
    expect(HomeAssistant.input_boolean.turn_on(helper)).toMatchObject({ domain: 'input_boolean', service: 'turn_on', target: helper });
    expect(HomeAssistant.input_boolean.turn_on(helper)).not.toHaveProperty('data');
  });

  it('turn_off has no data', () => {
    expect(HomeAssistant.input_boolean.turn_off(helper)).toMatchObject({ domain: 'input_boolean', service: 'turn_off' });
  });
});

// ---------- input_number ----------

describe('HomeAssistant.input_number', () => {
  const helper = { entity_id: 'input_number.global_temperature_comfort' };

  it('set_value includes value in data', () => {
    expect(HomeAssistant.input_number.set_value(helper, { value: 21 })).toMatchObject({ domain: 'input_number', service: 'set_value', data: { value: 21 } });
  });

  it('increment has no data', () => {
    expect(HomeAssistant.input_number.increment(helper)).not.toHaveProperty('data');
  });
});

// ---------- input_select ----------

describe('HomeAssistant.input_select', () => {
  const helper = { entity_id: 'input_select.house_active_mode_modifier' };

  it('select_option includes option in data', () => {
    expect(HomeAssistant.input_select.select_option(helper, { option: 'guest' })).toMatchObject({ domain: 'input_select', service: 'select_option', data: { option: 'guest' } });
  });

  it('select_next has no data', () => {
    expect(HomeAssistant.input_select.select_next(helper)).not.toHaveProperty('data');
  });
});

// ---------- button ----------

describe('HomeAssistant.button', () => {
  it('press emits correct action with no data', () => {
    const b = { entity_id: 'button.restart' };
    expect(HomeAssistant.button.press(b)).toMatchObject({ domain: 'button', service: 'press', target: b });
    expect(HomeAssistant.button.press(b)).not.toHaveProperty('data');
  });
});

// ---------- number ----------

describe('HomeAssistant.number', () => {
  it('set_value includes value in data', () => {
    expect(HomeAssistant.number.set_value({ entity_id: 'number.bedroom_volume' }, { value: 5 })).toMatchObject({ domain: 'number', service: 'set_value', data: { value: 5 } });
  });
});

// ---------- select ----------

describe('HomeAssistant.select', () => {
  it('select_option includes option in data', () => {
    expect(HomeAssistant.select.select_option({ entity_id: 'select.mode' }, { option: 'auto' })).toMatchObject({ domain: 'select', service: 'select_option', data: { option: 'auto' } });
  });
});

// ---------- alarm_control_panel ----------

describe('HomeAssistant.alarm_control_panel', () => {
  const panel = { entity_id: 'alarm_control_panel.home' };

  it('disarm with code includes code in data', () => {
    expect(HomeAssistant.alarm_control_panel.disarm(panel, { code: '9999' })).toMatchObject({ domain: 'alarm_control_panel', service: 'disarm', data: { code: '9999' } });
  });

  it('arm_away without code has no data', () => {
    expect(HomeAssistant.alarm_control_panel.arm_away(panel)).not.toHaveProperty('data');
  });
});

// ---------- shared Action shape ----------

describe('Action shape', () => {
  it('every builder produces type: ha.call_service', () => {
    const actions = [
      HomeAssistant.light.turn_on(target),
      HomeAssistant.switch.turn_off({ entity_id: 'switch.x' }),
      HomeAssistant.climate.turn_on({ entity_id: 'climate.x' }),
      HomeAssistant.input_boolean.toggle({ entity_id: 'input_boolean.x' }),
    ];
    expect(actions.every(a => a.type === 'ha.call_service')).toBe(true);
  });

  it('optional data with undefined value is omitted entirely', () => {
    const action = HomeAssistant.light.turn_on(target, undefined);
    expect(action).not.toHaveProperty('data');
  });
});
