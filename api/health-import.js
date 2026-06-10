// api/health-import.js
// ═══════════════════════════════════════════════════════════════
//  LIFE TRACKER — Import XML Apple Health
//  Route Vercel : POST /api/health-import
//
//  Reçoit un fichier export.xml d'Apple Health (multipart/form-data
//  ou base64 dans le body JSON), parse les données, et les insère
//  dans Supabase via upsert (pas de doublons).
//
//  Usage côté client :
//    const form = new FormData();
//    form.append('file', xmlFile);
//    fetch('/api/health-import', { method: 'POST', body: form });
// ═══════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import formidable from 'formidable';
import fs from 'fs';

// ── Désactive le body parser Vercel pour gérer le multipart nous-mêmes
export const config = { api: { bodyParser: false } };

// ── Client Supabase (service role = bypass RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Mapping type Apple Health → table Supabase
// Chaque type XML Apple Health est mapé vers : table, champ valeur, et parseur
const TYPE_MAP = {
  // ── Cardio ────────────────────────────────────────────────────
  'HKQuantityTypeIdentifierHeartRate': {
    table: 'heart_rate',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      bpm: parseFloat(r['@_value']),
      context: guessHeartRateContext(r),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierRestingHeartRate': {
    table: 'resting_heart_rate',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      bpm: parseFloat(r['@_value']),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierWalkingHeartRateAverage': {
    table: 'walking_heart_rate',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      bpm: parseFloat(r['@_value']),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': {
    table: 'hrv',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      sdnn_ms: parseFloat(r['@_value']),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierVO2Max': {
    table: 'vo2max',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      value: parseFloat(r['@_value']),
      source: parseSource(r['@_sourceName'])
    })
  },

  // ── Activité ──────────────────────────────────────────────────
  'HKQuantityTypeIdentifierStepCount': {
    table: '_steps_raw',  // agrégé par jour plus bas
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      steps: parseInt(r['@_value'], 10),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierDistanceWalkingRunning': {
    table: '_distance_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      km: parseFloat(r['@_value']) * (r['@_unit'] === 'm' ? 0.001 : 1),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierFlightsClimbed': {
    table: '_floors_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      floors: parseInt(r['@_value'], 10)
    })
  },
  'HKQuantityTypeIdentifierActiveEnergyBurned': {
    table: '_active_cal_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      kcal: parseFloat(r['@_value'])
    })
  },
  'HKQuantityTypeIdentifierBasalEnergyBurned': {
    table: '_basal_cal_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      kcal: parseFloat(r['@_value'])
    })
  },
  'HKQuantityTypeIdentifierAppleExerciseTime': {
    table: '_exercise_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      minutes: parseInt(r['@_value'], 10)
    })
  },
  'HKQuantityTypeIdentifierAppleStandTime': {
    table: '_stand_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      minutes: parseInt(r['@_value'], 10)
    })
  },

  // ── Respiratoire & O2 ─────────────────────────────────────────
  'HKQuantityTypeIdentifierOxygenSaturation': {
    table: 'spo2',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      percentage: parseFloat(r['@_value']) * 100, // Apple stocke en 0-1
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierRespiratoryRate': {
    table: 'respiratory_rate',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      breaths_pm: parseFloat(r['@_value']),
      context: 'rest',
      source: parseSource(r['@_sourceName'])
    })
  },

  // ── Température ───────────────────────────────────────────────
  'HKQuantityTypeIdentifierBodyTemperature': {
    table: 'body_temperature',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      celsius: parseFloat(r['@_value']),
      source: parseSource(r['@_sourceName'])
    })
  },
  'HKQuantityTypeIdentifierAppleSleepingWristTemperature': {
    table: 'body_temperature',
    build: (r) => ({
      recorded_at: r['@_startDate'],
      celsius: parseFloat(r['@_value']) + 36.5, // écart → température absolue approx
      deviation: parseFloat(r['@_value']),
      source: parseSource(r['@_sourceName'])
    })
  },

  // ── Audition ──────────────────────────────────────────────────
  'HKQuantityTypeIdentifierHeadphoneAudioExposure': {
    table: '_hearing_headphone_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      db: parseFloat(r['@_value'])
    })
  },
  'HKQuantityTypeIdentifierEnvironmentalAudioExposure': {
    table: '_hearing_env_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      db: parseFloat(r['@_value'])
    })
  },
  'HKQuantityTypeIdentifierEnvironmentalAudioExposureEvent': {
    table: '_hearing_events_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      count: 1
    })
  },

  // ── Poids / Corps ─────────────────────────────────────────────
  'HKQuantityTypeIdentifierBodyMass': {
    table: '_weight_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      kg: parseFloat(r['@_value']) * (r['@_unit'] === 'lb' ? 0.4536 : 1)
    })
  },
  'HKQuantityTypeIdentifierBodyMassIndex': {
    table: '_bmi_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      bmi: parseFloat(r['@_value'])
    })
  },
  'HKQuantityTypeIdentifierBodyFatPercentage': {
    table: '_bodyfat_raw',
    build: (r) => ({
      date: r['@_startDate'].split('T')[0],
      pct: parseFloat(r['@_value']) * 100
    })
  },
};

// ═══════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vérification de l'auth basique (token dans les env vars)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.IMPORT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // ── 1. Parse le fichier multipart
    const form = formidable({ maxFileSize: 500 * 1024 * 1024 }); // 500MB max (export XML peut être gros)
    const [, files] = await form.parse(req);
    const xmlFile = files.file?.[0];
    if (!xmlFile) return res.status(400).json({ error: 'No file provided' });

    const xmlContent = fs.readFileSync(xmlFile.filepath, 'utf-8');

    // ── 2. Parse le XML
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const result = parser.parse(xmlContent);
    const records = result?.HealthData?.Record || [];
    const workouts = result?.HealthData?.Workout || [];
    const sleepRecords = records.filter(r =>
      r['@_type'] === 'HKCategoryTypeIdentifierSleepAnalysis'
    );

    console.log(`[import] ${records.length} records, ${workouts.length} workouts, ${sleepRecords.length} sleep entries`);

    // ── 3. Trier les records par type
    const buckets = {}; // table_name → [{...data}]
    let skipped = 0;

    for (const record of records) {
      const type = record['@_type'];
      const mapping = TYPE_MAP[type];
      if (!mapping) { skipped++; continue; }

      const built = mapping.build(record);
      if (!buckets[mapping.table]) buckets[mapping.table] = [];
      buckets[mapping.table].push(built);
    }

    // ── 4. Agréger les données journalières (steps, activité, audition, poids)
    const dailyData = aggregateDailyData(buckets);

    // ── 5. Parser le sommeil (format spécial Apple Health)
    const sleepSessions = parseSleepSessions(sleepRecords);

    // ── 6. Upsert dans Supabase par batch de 500
    const stats = {};

    // Tables directes (sans agrégation)
    const directTables = ['heart_rate', 'resting_heart_rate', 'walking_heart_rate',
                          'hrv', 'vo2max', 'spo2', 'respiratory_rate',
                          'body_temperature'];

    for (const table of directTables) {
      if (buckets[table]?.length) {
        stats[table] = await upsertBatch(table, buckets[table], 'recorded_at');
      }
    }

    // Tables agrégées par jour
    if (dailyData.steps?.length) stats.steps = await upsertBatch('steps', dailyData.steps, 'recorded_date');
    if (dailyData.activity?.length) stats.activity = await upsertBatch('activity', dailyData.activity, 'recorded_date');
    if (dailyData.hearing?.length) stats.hearing = await upsertBatch('hearing', dailyData.hearing, 'recorded_date');
    if (dailyData.body_metrics?.length) stats.body_metrics = await upsertBatch('body_metrics', dailyData.body_metrics, 'recorded_date');

    // Sommeil
    if (sleepSessions.length) stats.sleep = await upsertBatch('sleep', sleepSessions, 'sleep_start');

    // ── 7. Log de sync
    const totalRecords = Object.values(stats).reduce((a, b) => a + (b || 0), 0);
    await supabase.from('sync_log').insert({
      source: 'xml_import',
      records_count: totalRecords,
      status: 'ok',
      details: stats
    });

    return res.status(200).json({
      success: true,
      imported: totalRecords,
      skipped,
      details: stats
    });

  } catch (error) {
    console.error('[import] Error:', error);
    await supabase.from('sync_log').insert({
      source: 'xml_import',
      status: 'error',
      error_msg: error.message
    });
    return res.status(500).json({ error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════════

// Upsert par batch de 500 pour éviter les timeouts
async function upsertBatch(table, rows, conflictColumn) {
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error, count } = await supabase
      .from(table)
      .upsert(batch, { onConflict: conflictColumn, ignoreDuplicates: true })
      .select('id', { count: 'exact', head: true });
    if (error) console.error(`[upsert] ${table} error:`, error.message);
    else inserted += (count || batch.length);
  }
  return inserted;
}

// Déduire le contexte d'une mesure FC
function guessHeartRateContext(record) {
  const source = (record['@_sourceName'] || '').toLowerCase();
  if (source.includes('workout')) return 'workout';
  const val = parseFloat(record['@_value']);
  if (val < 60) return 'resting';
  if (val > 120) return 'active';
  return 'rest';
}

// Normalise le nom de la source (Apple Watch, iPhone, etc.)
function parseSource(sourceName) {
  if (!sourceName) return 'apple_health';
  const s = sourceName.toLowerCase();
  if (s.includes('watch')) return 'apple_watch';
  if (s.includes('iphone')) return 'iphone';
  return sourceName;
}

// ── Agrège les données journalières depuis les buckets temporaires
function aggregateDailyData(buckets) {
  const result = { steps: [], activity: [], hearing: [], body_metrics: [] };

  // Steps + distance + étages
  const stepsByDay = groupBy(buckets['_steps_raw'] || [], 'date');
  const distByDay  = groupBy(buckets['_distance_raw'] || [], 'date');
  const floorsByDay = groupBy(buckets['_floors_raw'] || [], 'date');
  for (const [date, rows] of Object.entries(stepsByDay)) {
    result.steps.push({
      recorded_date: date,
      step_count: rows.reduce((a, r) => a + r.steps, 0),
      distance_km: (distByDay[date] || []).reduce((a, r) => a + r.km, 0) || null,
      floors_climbed: (floorsByDay[date] || []).reduce((a, r) => a + r.floors, 0) || 0
    });
  }

  // Activité (calories, exercice, debout)
  const activeDays = new Set([
    ...Object.keys(groupBy(buckets['_active_cal_raw'] || [], 'date')),
    ...Object.keys(groupBy(buckets['_exercise_raw'] || [], 'date'))
  ]);
  const activeCalByDay  = groupBy(buckets['_active_cal_raw'] || [], 'date');
  const basalCalByDay   = groupBy(buckets['_basal_cal_raw'] || [], 'date');
  const exerciseByDay   = groupBy(buckets['_exercise_raw'] || [], 'date');
  const standByDay      = groupBy(buckets['_stand_raw'] || [], 'date');
  for (const date of activeDays) {
    result.activity.push({
      recorded_date: date,
      active_calories: Math.round((activeCalByDay[date] || []).reduce((a, r) => a + r.kcal, 0)) || null,
      basal_calories:  Math.round((basalCalByDay[date]  || []).reduce((a, r) => a + r.kcal, 0)) || null,
      exercise_minutes: (exerciseByDay[date] || []).reduce((a, r) => a + r.minutes, 0) || null,
      stand_hours: Math.round((standByDay[date] || []).reduce((a, r) => a + r.minutes, 0) / 60) || null
    });
  }

  // Audition
  const hpByDay     = groupBy(buckets['_hearing_headphone_raw'] || [], 'date');
  const envByDay    = groupBy(buckets['_hearing_env_raw'] || [], 'date');
  const evtByDay    = groupBy(buckets['_hearing_events_raw'] || [], 'date');
  const hearingDays = new Set([...Object.keys(hpByDay), ...Object.keys(envByDay)]);
  for (const date of hearingDays) {
    const hpRows = hpByDay[date] || [];
    const envRows = envByDay[date] || [];
    result.hearing.push({
      recorded_date: date,
      headphone_exposure_db: hpRows.length ? avg(hpRows.map(r => r.db)) : null,
      env_exposure_db: envRows.length ? avg(envRows.map(r => r.db)) : null,
      audio_exposure_events: (evtByDay[date] || []).length || 0
    });
  }

  // Poids & composition
  const weightByDay  = groupBy(buckets['_weight_raw'] || [], 'date');
  const bmiByDay     = groupBy(buckets['_bmi_raw'] || [], 'date');
  const fatByDay     = groupBy(buckets['_bodyfat_raw'] || [], 'date');
  for (const [date, rows] of Object.entries(weightByDay)) {
    result.body_metrics.push({
      recorded_date: date,
      weight_kg: rows[rows.length - 1]?.kg || null, // dernière mesure du jour
      bmi: (bmiByDay[date] || []).at(-1)?.bmi || null,
      body_fat_pct: (fatByDay[date] || []).at(-1)?.pct || null
    });
  }

  return result;
}

// ── Parse les sessions de sommeil Apple Health
// Apple Health encode le sommeil en segments multiples (InBed, Asleep, REM, etc.)
// On les regroupe par nuit (23h → 12h du lendemain)
function parseSleepSessions(records) {
  if (!records.length) return [];

  // Valeurs Apple Health pour les phases
  const PHASES = {
    'HKCategoryValueSleepAnalysisInBed': 'inbed',
    'HKCategoryValueSleepAnalysisAsleepUnspecified': 'core',
    'HKCategoryValueSleepAnalysisAwake': 'awake',
    'HKCategoryValueSleepAnalysisAsleepCore': 'core',
    'HKCategoryValueSleepAnalysisAsleepDeep': 'deep',
    'HKCategoryValueSleepAnalysisAsleepREM': 'rem'
  };

  // Grouper par nuit : si le coucher est avant minuit, la nuit = date du coucher
  const nights = {};
  for (const r of records) {
    const phase = PHASES[r['@_value']];
    if (!phase || phase === 'inbed') continue; // on ignore InBed (juste être au lit)

    const start = new Date(r['@_startDate']);
    const end   = new Date(r['@_endDate']);
    // La nuit est assignée à la date du coucher (avant 12h = nuit précédente)
    const nightDate = start.getHours() < 12
      ? new Date(start.getTime() - 86400000).toISOString().split('T')[0]
      : start.toISOString().split('T')[0];

    if (!nights[nightDate]) nights[nightDate] = { segments: [], start, end };
    else {
      if (start < nights[nightDate].start) nights[nightDate].start = start;
      if (end > nights[nightDate].end) nights[nightDate].end = end;
    }
    nights[nightDate].segments.push({ phase, start, end });
  }

  return Object.entries(nights).map(([, night]) => {
    const mins = (phase) => night.segments
      .filter(s => s.phase === phase)
      .reduce((a, s) => a + (s.end - s.start) / 60000, 0);

    const awake = Math.round(mins('awake'));
    const core  = Math.round(mins('core'));
    const deep  = Math.round(mins('deep'));
    const rem   = Math.round(mins('rem'));
    const total = Math.round((night.end - night.start) / 60000);
    const sleeping = core + deep + rem;

    return {
      sleep_start: night.start.toISOString(),
      sleep_end:   night.end.toISOString(),
      duration_min: total,
      awake_min: awake,
      core_min: core,
      deep_min: deep,
      rem_min: rem,
      efficiency_pct: total > 0 ? Math.round((sleeping / total) * 100 * 10) / 10 : null
    };
  }).filter(s => s.duration_min > 60); // ignorer les siestes < 1h
}

// Helpers
function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    (acc[item[key]] = acc[item[key]] || []).push(item);
    return acc;
  }, {});
}
function avg(arr) {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0;
}
