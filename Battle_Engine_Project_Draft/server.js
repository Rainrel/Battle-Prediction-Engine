const express = require('express')
const cors = require('cors')
const path = require('path')
const sqlite3 = require('sqlite3').verbose()

const app = express()
const PORT = process.env.PORT || 3001
const db = new sqlite3.Database(path.join(__dirname, 'battle_engine.sqlite'))
const POKEAPI_BASE = 'https://pokeapi.co/api/v2'

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'dist')))

const typeChart = {
  Normal: { weakTo: ['Fighting'], strongAgainst: [] },
  Fire: { weakTo: ['Water', 'Ground', 'Rock'], strongAgainst: ['Grass', 'Ice', 'Bug', 'Steel'] },
  Water: { weakTo: ['Electric', 'Grass'], strongAgainst: ['Fire', 'Ground', 'Rock'] },
  Electric: { weakTo: ['Ground'], strongAgainst: ['Water', 'Flying'] },
  Grass: { weakTo: ['Fire', 'Ice', 'Poison', 'Flying', 'Bug'], strongAgainst: ['Water', 'Ground', 'Rock'] },
  Ice: { weakTo: ['Fire', 'Fighting', 'Rock', 'Steel'], strongAgainst: ['Grass', 'Ground', 'Flying', 'Dragon'] },
  Fighting: { weakTo: ['Flying', 'Psychic', 'Fairy'], strongAgainst: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'] },
  Poison: { weakTo: ['Ground', 'Psychic'], strongAgainst: ['Grass', 'Fairy'] },
  Ground: { weakTo: ['Water', 'Grass', 'Ice'], strongAgainst: ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'] },
  Flying: { weakTo: ['Electric', 'Ice', 'Rock'], strongAgainst: ['Grass', 'Fighting', 'Bug'] },
  Psychic: { weakTo: ['Bug', 'Ghost', 'Dark'], strongAgainst: ['Fighting', 'Poison'] },
  Bug: { weakTo: ['Fire', 'Flying', 'Rock'], strongAgainst: ['Grass', 'Psychic', 'Dark'] },
  Rock: { weakTo: ['Water', 'Grass', 'Fighting', 'Ground', 'Steel'], strongAgainst: ['Fire', 'Ice', 'Flying', 'Bug'] },
  Ghost: { weakTo: ['Ghost', 'Dark'], strongAgainst: ['Psychic', 'Ghost'] },
  Dragon: { weakTo: ['Ice', 'Dragon', 'Fairy'], strongAgainst: ['Dragon'] },
  Dark: { weakTo: ['Fighting', 'Bug', 'Fairy'], strongAgainst: ['Psychic', 'Ghost'] },
  Steel: { weakTo: ['Fire', 'Fighting', 'Ground'], strongAgainst: ['Ice', 'Rock', 'Fairy'] },
  Fairy: { weakTo: ['Poison', 'Steel'], strongAgainst: ['Fighting', 'Dragon', 'Dark'] },
}

class ValidationError extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
    this.details = details
  }
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function callback(err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err)
      else resolve(row)
    })
  })
}

async function initialize() {
  await run(`
    CREATE TABLE IF NOT EXISTS predictions (
      match_id TEXT PRIMARY KEY,
      gym_leader_name TEXT NOT NULL,
      challenger_name TEXT NOT NULL,
      gym_leader_region TEXT NOT NULL,
      gym_leader_type TEXT NOT NULL,
      challenger_region TEXT NOT NULL,
      gym_leader_lineup TEXT NOT NULL,
      challenger_lineup TEXT NOT NULL,
      engines_used TEXT NOT NULL,
      predicted_winner TEXT NOT NULL,
      confidence REAL NOT NULL,
      prediction_reason TEXT NOT NULL,
      prediction_timestamp TEXT NOT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS ground_truth (
      match_id TEXT PRIMARY KEY,
      actual_winner TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      replay_link TEXT,
      screenshot_link TEXT,
      final_score TEXT,
      number_of_turns INTEGER,
      result_timestamp TEXT NOT NULL,
      FOREIGN KEY(match_id) REFERENCES predictions(match_id)
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator TEXT NOT NULL,
      action_done TEXT NOT NULL,
      affected_record TEXT NOT NULL,
      new_value TEXT,
      timestamp TEXT NOT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS pokemon_profile_cache (
      pokemon_name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      types_json TEXT NOT NULL,
      is_legendary INTEGER NOT NULL,
      is_mythical INTEGER NOT NULL,
      is_mega INTEGER NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `)
}

function normalizeWinner(value) {
  return String(value || '').toLowerCase().includes('leader') ? 'Gym Leader' : 'Challenger'
}

function splitLineup(value) {
  return String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

function toTitleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function normalizePokemonName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\s+/g, '-')
}

function restrictionReasons(profile) {
  const reasons = []
  if (profile.isLegendary) reasons.push('legendary')
  if (profile.isMythical) reasons.push('mythical')
  if (profile.isMega) reasons.push('mega evolved')
  return reasons
}

async function getPokemonProfile(name) {
  const displayName = String(name || '').trim()
  const apiName = normalizePokemonName(displayName)

  if (!apiName) {
    return {
      name: displayName,
      types: ['Normal'],
      source: 'fallback',
      isLegendary: false,
      isMythical: false,
      isMega: false,
      warning: 'blank Pokemon name defaulted to Normal',
    }
  }

  const cached = await get(
    'SELECT types_json, is_legendary, is_mythical, is_mega, source FROM pokemon_profile_cache WHERE pokemon_name = ?',
    [apiName],
  )

  if (cached) {
    return {
      name: displayName,
      types: JSON.parse(cached.types_json),
      source: cached.source === 'fallback' ? 'fallback' : 'cache',
      isLegendary: Boolean(cached.is_legendary),
      isMythical: Boolean(cached.is_mythical),
      isMega: Boolean(cached.is_mega),
    }
  }

  try {
    const response = await fetch(`${POKEAPI_BASE}/pokemon/${encodeURIComponent(apiName)}`)
    if (!response.ok) throw new Error(`PokeAPI returned ${response.status}`)

    const data = await response.json()
    const speciesResponse = await fetch(data.species.url)
    if (!speciesResponse.ok) throw new Error(`PokeAPI species returned ${speciesResponse.status}`)

    const species = await speciesResponse.json()
    const types = data.types
      .sort((a, b) => a.slot - b.slot)
      .map((entry) => toTitleCase(entry.type.name))
      .filter((type) => typeChart[type])

    if (!types.length) throw new Error('PokeAPI response did not include usable type data')

    const profile = {
      name: displayName,
      types,
      source: 'pokeapi',
      isLegendary: Boolean(species.is_legendary),
      isMythical: Boolean(species.is_mythical),
      isMega: data.name.includes('-mega') || apiName.includes('-mega') || displayName.toLowerCase().includes('mega '),
    }

    await run(
      `INSERT OR REPLACE INTO pokemon_profile_cache (
        pokemon_name, display_name, types_json, is_legendary, is_mythical, is_mega, source, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        apiName,
        displayName,
        JSON.stringify(types),
        profile.isLegendary ? 1 : 0,
        profile.isMythical ? 1 : 0,
        profile.isMega ? 1 : 0,
        'pokeapi',
        new Date().toISOString(),
      ],
    )

    return profile
  } catch (error) {
    const types = ['Normal']
    await run(
      `INSERT OR REPLACE INTO pokemon_profile_cache (
        pokemon_name, display_name, types_json, is_legendary, is_mythical, is_mega, source, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [apiName, displayName, JSON.stringify(types), 0, 0, 0, 'fallback', new Date().toISOString()],
    )

    return {
      name: displayName,
      types,
      source: 'fallback',
      isLegendary: false,
      isMythical: false,
      isMega: false,
      warning: `${displayName} was not found in PokeAPI and defaulted to Normal`,
    }
  }
}

async function resolveLineupTypes(lineup) {
  const resolved = await Promise.all(lineup.map(getPokemonProfile))
  const restricted = resolved
    .map((pokemon) => ({
      name: pokemon.name,
      reasons: restrictionReasons(pokemon),
    }))
    .filter((pokemon) => pokemon.reasons.length)

  return {
    resolved,
    types: resolved.flatMap((pokemon) => pokemon.types),
    restricted,
    warnings: resolved.filter((pokemon) => pokemon.warning).map((pokemon) => pokemon.warning),
    sources: resolved.reduce((counts, pokemon) => {
      counts[pokemon.source] = (counts[pokemon.source] || 0) + 1
      return counts
    }, {}),
  }
}

async function matchupScore(attackingLineup, defendingLineup, gymLeaderType) {
  const attacker = await resolveLineupTypes(attackingLineup)
  const defender = await resolveLineupTypes(defendingLineup)
  const restricted = [...attacker.restricted, ...defender.restricted]

  if (restricted.length) {
    throw new ValidationError(
      `Lineup rejected. Legendary, mythical, and mega evolved Pokemon are not allowed: ${restricted
        .map((pokemon) => `${pokemon.name} (${pokemon.reasons.join(', ')})`)
        .join('; ')}.`,
      restricted,
    )
  }

  const attackerTypes = attacker.types
  const defenderTypes = defender.types
  const leaderType = typeChart[gymLeaderType] ? gymLeaderType : null
  let score = 0
  const reasons = []

  attackerTypes.forEach((type) => {
    if (leaderType && typeChart[type]?.strongAgainst.includes(leaderType)) {
      score += 2
      reasons.push(`${type} coverage pressures ${leaderType}`)
    }

    defenderTypes.forEach((defType) => {
      if (typeChart[type]?.strongAgainst.includes(defType)) score += 0.6
    })
  })

  defenderTypes.forEach((type) => {
    attackerTypes.forEach((atkType) => {
      if (typeChart[type]?.strongAgainst.includes(atkType)) score -= 0.45
    })
  })

  const uniqueAttackerTypes = new Set(attackerTypes).size
  const uniqueDefenderTypes = new Set(defenderTypes).size
  score += (uniqueAttackerTypes - uniqueDefenderTypes) * 0.25

  return {
    score,
    reasons,
    uniqueAttackerTypes,
    uniqueDefenderTypes,
    warnings: [...attacker.warnings, ...defender.warnings],
    sources: {
      pokeapi: (attacker.sources.pokeapi || 0) + (defender.sources.pokeapi || 0),
      fallback: (attacker.sources.fallback || 0) + (defender.sources.fallback || 0),
      cache: (attacker.sources.cache || 0) + (defender.sources.cache || 0),
    },
  }
}

async function predictBattle(payload) {
  const gymLineup = splitLineup(payload.gymLeaderLineup || payload.defendingLineup)
  const challengerLineup = splitLineup(payload.challengerLineup || payload.attackingLineup)
  const gymLeaderType = payload.gymLeaderType || 'Electric'
  const matchup = await matchupScore(challengerLineup, gymLineup, gymLeaderType)
  const probability = 1 / (1 + Math.exp(-matchup.score / 3))
  const predictedWinner = probability >= 0.5 ? 'Challenger' : 'Gym Leader'
  const confidence = predictedWinner === 'Challenger' ? probability : 1 - probability
  const reasonParts = matchup.reasons.slice(0, 3)

  if (matchup.uniqueAttackerTypes > matchup.uniqueDefenderTypes) {
    reasonParts.push('challenger has broader type coverage')
  } else if (matchup.uniqueDefenderTypes > matchup.uniqueAttackerTypes) {
    reasonParts.push('gym leader has broader defensive coverage')
  }

  if (!reasonParts.length) reasonParts.push('lineup balance and known type interactions are nearly even')
  if (matchup.sources.pokeapi > 0) reasonParts.push(`type data fetched from PokeAPI for ${matchup.sources.pokeapi} Pokemon`)
  if (matchup.sources.cache > 0) reasonParts.push(`type data loaded from local cache for ${matchup.sources.cache} Pokemon`)
  if (matchup.warnings.length) reasonParts.push(`fallback used: ${matchup.warnings.join('; ')}`)

  return {
    predictedWinner,
    confidence: Number(confidence.toFixed(2)),
    probabilityChallenger: Number(probability.toFixed(4)),
    predictionReason: `Rule-Based Classifier: ${reasonParts.join('; ')}.`,
  }
}

async function audit(action, matchId, value) {
  await run(
    'INSERT INTO audit_logs (operator, action_done, affected_record, new_value, timestamp) VALUES (?, ?, ?, ?, ?)',
    ['BI-TEAM-01', action, matchId, value, new Date().toISOString()],
  )
}

app.post('/api/predict', async (req, res) => {
  try {
    const payload = req.body
    const matchId = String(payload.matchId || '').trim()
    const gymLeaderName = String(payload.gymLeaderName || 'Gym Leader').trim()
    const challengerName = String(payload.challengerName || payload.challengerIdentifier || 'Challenger').trim()
    const gymLeaderRegion = String(payload.gymLeaderRegion || payload.gymTargetRegion || '').trim()
    const gymLeaderType = String(payload.gymLeaderType || '').trim()
    const challengerRegion = String(payload.challengerRegion || '').trim()
    const gymLeaderLineup = String(payload.gymLeaderLineup || payload.defendingLineup || '').trim()
    const challengerLineup = String(payload.challengerLineup || payload.attackingLineup || '').trim()
    const enginesUsed = String(payload.enginesUsed || 'Battle Prediction Engine').trim()

    const missing = [
      ['matchId', matchId],
      ['gymLeaderName', gymLeaderName],
      ['challengerName', challengerName],
      ['gymLeaderRegion', gymLeaderRegion],
      ['gymLeaderType', gymLeaderType],
      ['challengerRegion', challengerRegion],
      ['gymLeaderLineup', gymLeaderLineup],
      ['challengerLineup', challengerLineup],
      ['enginesUsed', enginesUsed],
    ].filter(([, value]) => !value)

    if (missing.length) {
      return res.status(400).json({ error: `Missing required pre-battle fields: ${missing.map(([key]) => key).join(', ')}` })
    }

    const prediction = await predictBattle({ ...payload, gymLeaderType, gymLeaderLineup, challengerLineup })
    const predictionTimestamp = new Date().toISOString()

    await run(
      `INSERT INTO predictions (
        match_id, gym_leader_name, challenger_name, gym_leader_region, gym_leader_type,
        challenger_region, gym_leader_lineup, challenger_lineup, engines_used,
        predicted_winner, confidence, prediction_reason, prediction_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id) DO UPDATE SET
        gym_leader_name = excluded.gym_leader_name,
        challenger_name = excluded.challenger_name,
        gym_leader_region = excluded.gym_leader_region,
        gym_leader_type = excluded.gym_leader_type,
        challenger_region = excluded.challenger_region,
        gym_leader_lineup = excluded.gym_leader_lineup,
        challenger_lineup = excluded.challenger_lineup,
        engines_used = excluded.engines_used,
        predicted_winner = excluded.predicted_winner,
        confidence = excluded.confidence,
        prediction_reason = excluded.prediction_reason,
        prediction_timestamp = excluded.prediction_timestamp`,
      [
        matchId,
        gymLeaderName,
        challengerName,
        gymLeaderRegion,
        gymLeaderType,
        challengerRegion,
        gymLeaderLineup,
        challengerLineup,
        enginesUsed,
        prediction.predictedWinner,
        prediction.confidence,
        prediction.predictionReason,
        predictionTimestamp,
      ],
    )

    await audit('INSERT PREDICTION', matchId, prediction.predictedWinner)

    return res.json({
      matchId,
      predictedWinner: prediction.predictedWinner,
      winner: prediction.predictedWinner,
      confidence: prediction.confidence,
      probabilityChallenger: prediction.probabilityChallenger,
      predictionReason: prediction.predictionReason,
      reasoning: prediction.predictionReason,
      timestamp: predictionTimestamp,
    })
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(error.status).json({ error: error.message, restrictedPokemon: error.details })
    }

    console.error(error)
    return res.status(500).json({ error: 'Prediction failed' })
  }
})

app.get('/api/pending', async (_req, res) => {
  const rows = await all(`
    SELECT p.match_id, p.gym_leader_name, p.challenger_name, p.predicted_winner, p.confidence, p.prediction_timestamp
    FROM predictions p
    LEFT JOIN ground_truth g ON g.match_id = p.match_id
    WHERE g.match_id IS NULL
    ORDER BY p.prediction_timestamp DESC
  `)

  res.json(
    rows.map((row) => ({
      matchId: row.match_id,
      match_id: row.match_id,
      challengerIdentifier: `${row.gym_leader_name} vs ${row.challenger_name}`,
      challenger_identifier: `${row.gym_leader_name} vs ${row.challenger_name}`,
      prediction: row.predicted_winner,
      predictedWinner: row.predicted_winner,
      predicted_winner: row.predicted_winner,
      confidence: row.confidence,
      prediction_timestamp: row.prediction_timestamp,
    })),
  )
})

app.post('/api/ground-truth', async (req, res) => {
  try {
    const matchId = String(req.body.matchId || '').trim()
    const prediction = await get('SELECT * FROM predictions WHERE match_id = ?', [matchId])
    if (!prediction) return res.status(404).json({ error: 'A pre-battle prediction must be recorded before ground truth can be logged.' })

    const actualWinner = normalizeWinner(req.body.actualWinner)
    const predictedWinner = normalizeWinner(prediction.predicted_winner)
    const isCorrect = actualWinner === predictedWinner ? 1 : 0
    const resultTimestamp = new Date().toISOString()

    await run(
      `INSERT INTO ground_truth (
        match_id, actual_winner, is_correct, replay_link, screenshot_link, final_score, number_of_turns, result_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id) DO UPDATE SET
        actual_winner = excluded.actual_winner,
        is_correct = excluded.is_correct,
        replay_link = excluded.replay_link,
        screenshot_link = excluded.screenshot_link,
        final_score = excluded.final_score,
        number_of_turns = excluded.number_of_turns,
        result_timestamp = excluded.result_timestamp`,
      [
        matchId,
        actualWinner,
        isCorrect,
        req.body.replayLink || '',
        req.body.screenshotLink || req.body.verificationLink || '',
        String(req.body.finalScore || ''),
        Number(req.body.numTurns || req.body.numberOfTurns || 0) || null,
        resultTimestamp,
      ],
    )

    await audit('RECORD GROUND TRUTH', matchId, `${actualWinner} (${isCorrect ? 'Correct' : 'Incorrect'})`)

    res.json({
      matchId,
      actualWinner,
      isCorrect: Boolean(isCorrect),
      correctIncorrect: isCorrect ? 'Correct' : 'Incorrect',
      timestamp: resultTimestamp,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Ground truth logging failed' })
  }
})

function safeDivide(numerator, denominator) {
  return denominator ? numerator / denominator : 0
}

app.get('/api/analytics', async (_req, res) => {
  const rows = await all(`
    SELECT p.predicted_winner, p.confidence, g.actual_winner, g.is_correct, g.number_of_turns
    FROM predictions p
    JOIN ground_truth g ON g.match_id = p.match_id
  `)
  const totalPredictions = await get('SELECT COUNT(*) AS count FROM predictions')
  const pending = await get(`
    SELECT COUNT(*) AS count
    FROM predictions p
    LEFT JOIN ground_truth g ON g.match_id = p.match_id
    WHERE g.match_id IS NULL
  `)
  const logs = await all('SELECT * FROM audit_logs ORDER BY audit_id DESC LIMIT 25')

  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  let trueNegative = 0
  let brierTotal = 0
  let logLossTotal = 0
  const buckets = {}

  rows.forEach((row) => {
    const predictedLeader = normalizeWinner(row.predicted_winner) === 'Gym Leader'
    const actualLeader = normalizeWinner(row.actual_winner) === 'Gym Leader'
    if (predictedLeader && actualLeader) truePositive += 1
    if (predictedLeader && !actualLeader) falsePositive += 1
    if (!predictedLeader && actualLeader) falseNegative += 1
    if (!predictedLeader && !actualLeader) trueNegative += 1

    const predictedProb = Math.min(Math.max(Number(row.confidence), 0.001), 0.999)
    const actual = row.is_correct ? 1 : 0
    brierTotal += (predictedProb - actual) ** 2
    logLossTotal += -(actual * Math.log(predictedProb) + (1 - actual) * Math.log(1 - predictedProb))

    const bucketFloor = Math.floor(predictedProb * 10) * 10
    const bucket = `${bucketFloor}-${bucketFloor + 9}%`
    buckets[bucket] ||= { bucket, predictions: 0, correct: 0, average_confidence: 0 }
    buckets[bucket].predictions += 1
    buckets[bucket].correct += actual
    buckets[bucket].average_confidence += predictedProb
  })

  const completed = rows.length
  const accuracy = safeDivide(truePositive + trueNegative, completed)
  const precision = safeDivide(truePositive, truePositive + falsePositive)
  const recall = safeDivide(truePositive, truePositive + falseNegative)
  const f1 = safeDivide(2 * precision * recall, precision + recall)

  res.json({
    total_matches: totalPredictions.count,
    completed_matches: completed,
    pending_matches: pending.count,
    accuracy,
    precision,
    recall,
    f1,
    f1_score: f1,
    brier_score: safeDivide(brierTotal, completed),
    log_loss: safeDivide(logLossTotal, completed),
    mean_turns: safeDivide(
      rows.reduce((sum, row) => sum + (Number(row.number_of_turns) || 0), 0),
      rows.filter((row) => Number(row.number_of_turns)).length,
    ),
    confusion_matrix: {
      true_positive: truePositive,
      false_positive: falsePositive,
      false_negative: falseNegative,
      true_negative: trueNegative,
    },
    calibration_table: Object.values(buckets).map((bucket) => ({
      ...bucket,
      average_confidence: safeDivide(bucket.average_confidence, bucket.predictions),
      observed_accuracy: safeDivide(bucket.correct, bucket.predictions),
    })),
    logs,
  })
})

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`Battle Prediction Engine API running on http://localhost:${PORT}`)
  })
})
