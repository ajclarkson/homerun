import type { Action } from './types/actions.js';

type Target = { entity_id: string };

function svc(domain: string, service: string, target?: Target, data?: object): Action {
  return { type: 'ha.call_service', domain, service, ...(target && { target }), ...(data !== undefined ? { data: data as unknown as Record<string, unknown> } : {}) };
}

// ---------- light ----------

export interface LightTurnOnData {
  transition?: number;
  brightness_pct?: number;
  brightness?: number;
  color_temp_kelvin?: number;
  rgb_color?: [number, number, number];
  effect?: string;
}

// ---------- climate ----------

export type HvacMode = 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only';

export interface ClimateSetTemperatureData {
  temperature?: number;
  target_temp_high?: number;
  target_temp_low?: number;
  hvac_mode?: HvacMode;
}

// ---------- cover ----------

export interface CoverSetPositionData { position: number }
export interface CoverSetTiltPositionData { tilt_position: number }

// ---------- media_player ----------

export type MediaPlayerEnqueue = 'next' | 'add' | 'play' | 'replace';
export type MediaPlayerRepeat = 'off' | 'all' | 'one';

export interface MediaPlayerPlayMediaData {
  media_content_id: string;
  media_content_type: string;
  enqueue?: MediaPlayerEnqueue;
  announce?: boolean;
}

// ---------- alarm_control_panel ----------

export type AlarmCode = { code?: string };

// ---------- HomeAssistant ----------

export const HomeAssistant = {

  light: {
    turn_on:  (target: Target, data?: LightTurnOnData): Action => svc('light', 'turn_on',  target, data),
    turn_off: (target: Target, data?: { transition?: number }): Action => svc('light', 'turn_off', target, data),
    toggle:   (target: Target, data?: LightTurnOnData): Action => svc('light', 'toggle',   target, data),
  },

  switch: {
    turn_on:  (target: Target): Action => svc('switch', 'turn_on',  target),
    turn_off: (target: Target): Action => svc('switch', 'turn_off', target),
    toggle:   (target: Target): Action => svc('switch', 'toggle',   target),
  },

  cover: {
    open_cover:          (target: Target): Action => svc('cover', 'open_cover',          target),
    close_cover:         (target: Target): Action => svc('cover', 'close_cover',         target),
    stop_cover:          (target: Target): Action => svc('cover', 'stop_cover',          target),
    toggle:              (target: Target): Action => svc('cover', 'toggle',              target),
    set_cover_position:  (target: Target, data: CoverSetPositionData): Action => svc('cover', 'set_cover_position',  target, data),
    set_cover_tilt_position: (target: Target, data: CoverSetTiltPositionData): Action => svc('cover', 'set_cover_tilt_position', target, data),
  },

  fan: {
    turn_on:       (target: Target, data?: { percentage?: number; preset_mode?: string }): Action => svc('fan', 'turn_on', target, data),
    turn_off:      (target: Target): Action => svc('fan', 'turn_off',      target),
    toggle:        (target: Target): Action => svc('fan', 'toggle',        target),
    set_percentage:(target: Target, data: { percentage: number }): Action => svc('fan', 'set_percentage', target, data),
    set_preset_mode:(target: Target, data: { preset_mode: string }): Action => svc('fan', 'set_preset_mode', target, data),
    increase_speed:(target: Target): Action => svc('fan', 'increase_speed', target),
    decrease_speed:(target: Target): Action => svc('fan', 'decrease_speed', target),
  },

  lock: {
    lock:   (target: Target, data?: AlarmCode): Action => svc('lock', 'lock',   target, data),
    unlock: (target: Target, data?: AlarmCode): Action => svc('lock', 'unlock', target, data),
    open:   (target: Target, data?: AlarmCode): Action => svc('lock', 'open',   target, data),
  },

  climate: {
    turn_on:         (target: Target): Action => svc('climate', 'turn_on',          target),
    turn_off:        (target: Target): Action => svc('climate', 'turn_off',         target),
    set_hvac_mode:   (target: Target, data: { hvac_mode: HvacMode }): Action => svc('climate', 'set_hvac_mode',   target, data),
    set_temperature: (target: Target, data: ClimateSetTemperatureData): Action => svc('climate', 'set_temperature', target, data),
    set_preset_mode: (target: Target, data: { preset_mode: string }): Action => svc('climate', 'set_preset_mode', target, data),
    set_fan_mode:    (target: Target, data: { fan_mode: string }): Action => svc('climate', 'set_fan_mode',    target, data),
    set_humidity:    (target: Target, data: { humidity: number }): Action => svc('climate', 'set_humidity',    target, data),
  },

  media_player: {
    turn_on:             (target: Target): Action => svc('media_player', 'turn_on',             target),
    turn_off:            (target: Target): Action => svc('media_player', 'turn_off',            target),
    toggle:              (target: Target): Action => svc('media_player', 'toggle',              target),
    media_play:          (target: Target): Action => svc('media_player', 'media_play',          target),
    media_pause:         (target: Target): Action => svc('media_player', 'media_pause',         target),
    media_play_pause:    (target: Target): Action => svc('media_player', 'media_play_pause',    target),
    media_stop:          (target: Target): Action => svc('media_player', 'media_stop',          target),
    media_next_track:    (target: Target): Action => svc('media_player', 'media_next_track',    target),
    media_previous_track:(target: Target): Action => svc('media_player', 'media_previous_track', target),
    volume_up:           (target: Target): Action => svc('media_player', 'volume_up',           target),
    volume_down:         (target: Target): Action => svc('media_player', 'volume_down',         target),
    volume_set:          (target: Target, data: { volume_level: number }): Action => svc('media_player', 'volume_set',  target, data),
    volume_mute:         (target: Target, data: { is_volume_muted: boolean }): Action => svc('media_player', 'volume_mute', target, data),
    select_source:       (target: Target, data: { source: string }): Action => svc('media_player', 'select_source', target, data),
    shuffle_set:         (target: Target, data: { shuffle: boolean }): Action => svc('media_player', 'shuffle_set',  target, data),
    repeat_set:          (target: Target, data: { repeat: MediaPlayerRepeat }): Action => svc('media_player', 'repeat_set',  target, data),
    play_media:          (target: Target, data: MediaPlayerPlayMediaData): Action => svc('media_player', 'play_media',  target, data),
  },

  alarm_control_panel: {
    arm_away:     (target: Target, data?: AlarmCode): Action => svc('alarm_control_panel', 'arm_away',     target, data),
    arm_home:     (target: Target, data?: AlarmCode): Action => svc('alarm_control_panel', 'arm_home',     target, data),
    arm_night:    (target: Target, data?: AlarmCode): Action => svc('alarm_control_panel', 'arm_night',    target, data),
    arm_vacation: (target: Target, data?: AlarmCode): Action => svc('alarm_control_panel', 'arm_vacation', target, data),
    disarm:       (target: Target, data?: AlarmCode): Action => svc('alarm_control_panel', 'disarm',       target, data),
    trigger:      (target: Target, data?: AlarmCode): Action => svc('alarm_control_panel', 'trigger',      target, data),
  },

  scene: {
    turn_on: (target: Target, data?: { transition?: number }): Action => svc('scene', 'turn_on', target, data),
  },

  input_boolean: {
    turn_on:  (target: Target): Action => svc('input_boolean', 'turn_on',  target),
    turn_off: (target: Target): Action => svc('input_boolean', 'turn_off', target),
    toggle:   (target: Target): Action => svc('input_boolean', 'toggle',   target),
  },

  input_number: {
    set_value: (target: Target, data: { value: number }): Action => svc('input_number', 'set_value', target, data),
    increment: (target: Target): Action => svc('input_number', 'increment', target),
    decrement: (target: Target): Action => svc('input_number', 'decrement', target),
    set_min:   (target: Target): Action => svc('input_number', 'min',       target),
    set_max:   (target: Target): Action => svc('input_number', 'max',       target),
  },

  input_select: {
    select_option: (target: Target, data: { option: string }): Action => svc('input_select', 'select_option', target, data),
    select_next:   (target: Target): Action => svc('input_select', 'select_next',   target),
    select_previous:(target: Target): Action => svc('input_select', 'select_previous', target),
    set_options:   (target: Target, data: { options: string[] }): Action => svc('input_select', 'set_options', target, data),
  },

  button: {
    press: (target: Target): Action => svc('button', 'press', target),
  },

  number: {
    set_value: (target: Target, data: { value: number }): Action => svc('number', 'set_value', target, data),
  },

  select: {
    select_option:  (target: Target, data: { option: string }): Action => svc('select', 'select_option',  target, data),
    select_next:    (target: Target): Action => svc('select', 'select_next',    target),
    select_previous:(target: Target): Action => svc('select', 'select_previous', target),
  },

} as const;
