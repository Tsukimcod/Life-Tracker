// api/health-sync.js
// ═══════════════════════════════════════════════════════════════
//  LIFE TRACKER — Sync iOS Shortcuts → Supabase
//  Route Vercel : POST /api/health-sync
//
//  Appelée automatiquement par un Raccourci iOS toutes les heures
//  (ou manuellement via le bouton "Synchroniser" sur le site).
//
//  Body JSON attendu (envoyé par le Raccourci iOS) :
//  {
//    "token": "TON_SECRET",
//    "ts": "2024-01-15T09:30:00",        // timestamp de la mesure
//    "heart_rate": 62,
//    "resting_hr": 52,
//    "hrv": 45.2,
//    "vo2max": 48.5,
//    "steps": 8432,
//    "active_calories": 420,
//    "exercise_min": 35,
//    "stand_hours": 9,
//    "sleep_start": "2024-01-14T23:10:00",
//    "sleep_end": "2024-01-15T07:25:00",
//    "sleep_deep": 68,
//    "sleep_rem": 95,
//    "sleep_core": 180,
//    "sleep_awake": 20,
//    "spo2": 97.5,
//    "respiratory_rate": 14.2,
//    "wrist_temp": 0.3,                  // écart vs baseline (°C)
//    "headphone_db": 72.1,
//    "env_db": 58.4,
//    "weight": 75.2,
//    "body_fat": 16.5
//  }
// ═══════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS pour permettre l'appel depuis le navigateur (bouton Sync)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;

  // ── Auth par token simple
  if (body.token !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const ts = body.ts || new Date().toISOString();
  const date = ts.split('T')[0];
  const inserted = {};

  try {
    // ── Fréquence cardiaque instantanée
    if (body.heart_rate != null) {
      await supabase.from('heart_rate').insert({
        recorded_at: ts,
        bpm: body.heart_rate,
        context: 'resting',
        source: 'ios_shortcut'
      });
      inserted.heart_rate = body.heart_rate;
    }

    // ── FC au repos (calculée par Apple sur la journée)
    if (body.resting_hr != null) {
      await supabase.from('resting_heart_rate').upsert({
        recorded_at: `${date}T12:00:00`,
        bpm: body.resting_hr,
        source: 'ios_shortcut'
      }, { onConflict: 'recorded_at', ignoreDuplicates: false });
      inserted.resting_hr = body.resting_hr;
    }

    // ── HRV
    if (body.hrv != null) {
      await supabase.from('hrv').insert({
        recorded_at: ts,
        sdnn_ms: body.hrv,
        source: 'ios_shortcut'
      });
      inserted.hrv = body.hrv;
    }

    // ── VO2 Max
    if (body.vo2max != null) {
      await supabase.from('vo2max').upsert({
        recorded_at: ts,
        value: body.vo2max,
        source: 'ios_shortcut'
      }, { onConflict: 'recorded_at', ignoreDuplicates: true });
      inserted.vo2max = body.vo2max;
    }

    // ── Pas + distance (agrégé journalier)
    if (body.steps != null) {
      await supabase.from('steps').upsert({
        recorded_date: date,
        step_count: body.steps,
        distance_km: body.distance_km || null,
        floors_climbed: body.floors || 0,
        source: 'ios_shortcut'
      }, { onConflict: 'recorded_date', ignoreDuplicates: false });
      inserted.steps = body.steps;
    }

    // ── Activité journalière (anneaux)
    if (body.active_calories != null || body.exercise_min != null) {
      await supabase.from('activity').upsert({
        recorded_date: date,
        active_calories: body.active_calories || null,
        basal_calories: body.basal_calories || null,
        exercise_minutes: body.exercise_min || null,
        stand_hours: body.stand_hours || null,
        source: 'ios_shortcut'
      }, { onConflict: 'recorded_date', ignoreDuplicates: false });
      inserted.activity = true;
    }

    // ── Sommeil (données de la nuit précédente)
    if (body.sleep_start && body.sleep_end) {
      const sleepDuration = body.sleep_deep + body.sleep_rem + body.sleep_core + (body.sleep_awake || 0);
      const sleeping = (body.sleep_deep || 0) + (body.sleep_rem || 0) + (body.sleep_core || 0);
      await supabase.from('sleep').upsert({
        sleep_start: body.sleep_start,
        sleep_end: body.sleep_end,
        duration_min: sleepDuration || null,
        awake_min: body.sleep_awake || 0,
        core_min: body.sleep_core || 0,
        deep_min: body.sleep_deep || 0,
        rem_min: body.sleep_rem || 0,
        efficiency_pct: sleepDuration > 0 ? Math.round(sleeping / sleepDuration * 1000) / 10 : null,
        source: 'ios_shortcut'
      }, { onConflict: 'sleep_start', ignoreDuplicates: false });
      inserted.sleep = true;
    }

    // ── SpO2
    if (body.spo2 != null) {
      await supabase.from('spo2').insert({
        recorded_at: ts,
        percentage: body.spo2,
        source: 'ios_shortcut'
      });
      inserted.spo2 = body.spo2;
    }

    // ── Fréquence respiratoire
    if (body.respiratory_rate != null) {
      await supabase.from('respiratory_rate').insert({
        recorded_at: ts,
        breaths_pm: body.respiratory_rate,
        context: 'rest',
        source: 'ios_shortcut'
      });
      inserted.respiratory_rate = body.respiratory_rate;
    }

    // ── Température poignet
    if (body.wrist_temp != null) {
      await supabase.from('body_temperature').insert({
        recorded_at: ts,
        celsius: 36.5 + body.wrist_temp,
        deviation: body.wrist_temp,
        source: 'ios_shortcut'
      });
      inserted.wrist_temp = body.wrist_temp;
    }

    // ── Audition
    if (body.headphone_db != null || body.env_db != null) {
      await supabase.from('hearing').upsert({
        recorded_date: date,
        headphone_exposure_db: body.headphone_db || null,
        env_exposure_db: body.env_db || null,
        audio_exposure_events: body.audio_events || 0,
        source: 'ios_shortcut'
      }, { onConflict: 'recorded_date', ignoreDuplicates: false });
      inserted.hearing = true;
    }

    // ── Poids
    if (body.weight != null) {
      await supabase.from('body_metrics').upsert({
        recorded_date: date,
        weight_kg: body.weight,
        body_fat_pct: body.body_fat || null,
        source: 'ios_shortcut'
      }, { onConflict: 'recorded_date', ignoreDuplicates: false });
      inserted.weight = body.weight;
    }

    // ── Log sync
    await supabase.from('sync_log').insert({
      source: 'ios_shortcut',
      records_count: Object.keys(inserted).length,
      status: 'ok',
      details: inserted
    });

    return res.status(200).json({ success: true, synced: inserted, timestamp: ts });

  } catch (error) {
    console.error('[sync] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
