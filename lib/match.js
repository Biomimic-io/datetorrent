'use strict'
// Matching runs entirely on your machine against your local replica of the
// database. Nothing about who you looked at or how they scored ever leaves it.

function compatible (me, them) {
  if (!me || !them || them.deleted || me.id === them.id) return false
  return me.seeking.includes(them.gender) && them.seeking.includes(me.gender) &&
    them.age >= me.ageMin && them.age <= me.ageMax &&
    me.age >= them.ageMin && me.age <= them.ageMax
}

const norm = (s) => String(s || '').trim().toLowerCase()

// 0-100. Shared interests carry most of the weight, then region, then how
// centred each person sits in the other's preferred age range.
function score (me, them) {
  const a = new Set(me.interests.map(norm))
  const b = new Set(them.interests.map(norm))
  const shared = [...a].filter((x) => b.has(x))
  const union = new Set([...a, ...b]).size
  const interestScore = union ? shared.length / union : 0

  const myRegion = norm(me.region)
  const theirRegion = norm(them.region)
  let regionScore = 0
  if (myRegion && myRegion === theirRegion) regionScore = 1
  else if (myRegion && theirRegion) {
    // "Portland, OR" vs "Salem, OR" share the trailing state/country part.
    const tail = (r) => r.split(',').pop().trim()
    if (tail(myRegion) === tail(theirRegion)) regionScore = 0.5
  }

  const centred = (age, lo, hi) => {
    const mid = (lo + hi) / 2
    const half = Math.max(1, (hi - lo) / 2)
    return 1 - Math.min(1, Math.abs(age - mid) / half)
  }
  const ageScore = (centred(them.age, me.ageMin, me.ageMax) + centred(me.age, them.ageMin, them.ageMax)) / 2

  const total = Math.round(100 * (0.55 * interestScore + 0.3 * regionScore + 0.15 * ageScore))
  return { total, shared }
}

function rank (me, profiles, exclude = new Set()) {
  return profiles
    .filter((p) => !exclude.has(p.id) && compatible(me, p))
    .map((p) => ({ profile: p, ...score(me, p) }))
    .sort((x, y) => y.total - x.total || y.profile.updated - x.profile.updated)
}

module.exports = { compatible, score, rank }
