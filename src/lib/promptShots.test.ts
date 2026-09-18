import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasPromptShotIssues, joinPromptShots, pairShotsWithPrompt, promptShotIssues,
  replacePromptShotText, splitPromptShots,
} from './promptShots'

/** A real-shaped Ref2VA body: style sentences before [Shot 1] (the film's
 * baked camera paragraph among them), then markers with strictly increasing
 * timestamps, a speaker id and a dialogue tag. A tailor in a Surat cloth
 * market finds a bolt has been switched on her. */
const BODY = `The target video is live-action and cinematic, shot on a Sony FX6 with a Fujinon Cabrio 19-90mm zoom, handheld. Late afternoon, shutters half down, dust in the light.
[Shot 1] Static Shot on the cutting table as <Subject 1> unrolls a bolt of raw silk across it, letting the end fall to the floor.
[Shot 2] At 00:04.500, Push In to her hands as she stops mid-pull and works a corner of the cloth between finger and thumb.
[Shot 3] At 00:09.200, Truck Right to find <Subject 2> in the doorway with the shutter at his shoulder, not coming in. (S2) says, unhurried, <d>[Hindi] वही माल है, बहन।</d>
[Shot 4] At 00:13.750, Static Shot holding both of them, her hand still on the cloth.`

test('splitPromptShots keeps the style preamble apart from the shots', () => {
  const split = splitPromptShots(BODY)
  assert.equal(split.shots.length, 4)
  assert.match(split.preamble, /Sony FX6/)
  assert.match(split.preamble, /dust in the light/)
  // The preamble stops before the first marker and never swallows it.
  assert.equal(split.preamble.includes('[Shot 1]'), false)
})

test('a shot fragment is the REAL text, not a paraphrase — including its dialogue tag', () => {
  const split = splitPromptShots(BODY)
  const three = split.shots[2]
  assert.equal(three.n, 3)
  assert.match(three.text, /<Subject 2> in the doorway/)
  assert.match(three.text, /\(S2\) says, unhurried/)
  assert.match(three.text, /<d>\[Hindi\] वही माल है, बहन।<\/d>/)
  // And it stops at the next marker.
  assert.equal(three.text.includes('[Shot 4]'), false)
})

test('[Shot 1] has no timestamp by rule; the later ones parse to milliseconds', () => {
  const split = splitPromptShots(BODY)
  assert.equal(split.shots[0].atMs, null)
  assert.equal(split.shots[1].atMs, 4500)
  assert.equal(split.shots[2].atMs, 9200)
  assert.equal(split.shots[3].atMs, 13750)
})

test('the marker is captured verbatim, so prose and marker can be styled apart', () => {
  const split = splitPromptShots(BODY)
  assert.equal(split.shots[1].marker, '[Shot 2] At 00:04.500,')
  assert.equal(split.shots[0].marker, '[Shot 1]')
})

test('splitting then rejoining is byte-identical — nothing is reflowed or trimmed', () => {
  assert.equal(joinPromptShots(splitPromptShots(BODY)), BODY)
})

test('a body with no markers is all preamble, never one invented shot', () => {
  const plain = 'She unrolls the bolt and stops. He watches from the doorway.'
  const split = splitPromptShots(plain)
  assert.equal(split.shots.length, 0)
  assert.equal(split.preamble, plain)
  assert.equal(promptShotIssues(split).noMarkers, true)
})

test('a body that opens straight on a marker has an empty preamble', () => {
  const split = splitPromptShots('[Shot 1] Static Shot on the table.')
  assert.equal(split.preamble, '')
  assert.equal(split.shots.length, 1)
})

test('inner spacing in the marker drifts without breaking the split', () => {
  const split = splitPromptShots('[Shot  1] a\n[Shot 2]  At 00:02.000, b')
  assert.equal(split.shots.length, 2)
  assert.equal(split.shots[1].atMs, 2000)
})

test('a missing trailing comma still yields the shot rather than losing it', () => {
  const split = splitPromptShots('[Shot 1] a\n[Shot 2] At 00:05.000 b')
  assert.equal(split.shots.length, 2)
  assert.equal(split.shots[1].atMs, 5000)
  assert.match(split.shots[1].text, /b/)
})

test('a two-digit fractional second is read as tenths/hundredths, not dropped', () => {
  assert.equal(splitPromptShots('[Shot 2] At 00:07.5, x').shots[0].atMs, 7500)
  assert.equal(splitPromptShots('[Shot 2] At 00:07.25, x').shots[0].atMs, 7250)
})

// ── editing one shot ────────────────────────────────────────────────────

test('replacePromptShotText rewrites one shot and leaves every other byte alone', () => {
  const edited = replacePromptShotText(BODY, 2, ' Push In to her hands as she stops and smells the cloth.\n')
  assert.match(edited, /smells the cloth/)
  assert.equal(edited.includes('works a corner of the cloth'), false)
  // Everything else survives, preamble and neighbours included.
  assert.match(edited, /Fujinon Cabrio 19-90mm/)
  assert.match(edited, /वही माल है, बहन।/)
  assert.match(edited, /\[Shot 4\] At 00:13\.750,/)
  // Shot count is unchanged — an edit is not an insert.
  assert.equal(splitPromptShots(edited).shots.length, 4)
})

test('editing a shot that is not there changes nothing, rather than appending one', () => {
  assert.equal(replacePromptShotText(BODY, 9, ' invented\n'), BODY)
})

// ── defects are reported, never corrected ───────────────────────────────

test('non-contiguous numbering is reported and the text is left exactly as written', () => {
  const body = '[Shot 1] a\n[Shot 2] At 00:03.000, b\n[Shot 4] At 00:06.000, c'
  const split = splitPromptShots(body)
  const issues = promptShotIssues(split)
  assert.deepEqual(issues.numbering, [4])
  assert.equal(hasPromptShotIssues(issues), true)
  // Not renumbered: the declared number is what the model actually wrote.
  assert.equal(split.shots[2].n, 4)
  assert.equal(joinPromptShots(split), body)
})

test('a timestamp that goes backwards is reported — the film clock disagrees with its text', () => {
  const issues = promptShotIssues(
    splitPromptShots('[Shot 1] a\n[Shot 2] At 00:09.000, b\n[Shot 3] At 00:04.000, c'),
  )
  assert.deepEqual(issues.outOfOrder, [3])
})

test('a later shot missing its timestamp is reported; [Shot 1] missing one is not', () => {
  const issues = promptShotIssues(splitPromptShots('[Shot 1] a\n[Shot 2] b\n[Shot 3] At 00:08.000, c'))
  assert.deepEqual(issues.missingTimestamps, [2])
  assert.equal(issues.firstShotTimestamped, false)
})

test('[Shot 1] carrying a timestamp is reported — the schema forbids it', () => {
  const issues = promptShotIssues(splitPromptShots('[Shot 1] At 00:00.000, a\n[Shot 2] At 00:04.000, b'))
  assert.equal(issues.firstShotTimestamped, true)
})

test('a clean body reports nothing wrong', () => {
  assert.equal(hasPromptShotIssues(promptShotIssues(splitPromptShots(BODY))), false)
})

// ── pairing the plan's shots with the prompt's fragments ────────────────

const PLANNED = [
  { index: 1, covers: 'she unrolls the bolt', seconds: 4.5 },
  { index: 2, covers: 'she tests the cloth between her fingers', seconds: 4.7 },
  { index: 3, covers: 'he appears in the doorway and does not come in', seconds: 4.55 },
  { index: 4, covers: 'they hold, her hand still on the cloth', seconds: 5.0 },
]

test('pairing is POSITIONAL, so bad numbering still puts the right prose on the right shot', () => {
  const body = '[Shot 1] a\n[Shot 2] At 00:04.500, b\n[Shot 4] At 00:09.200, c\n[Shot 5] At 00:13.750, d'
  const { pairs, orphans } = pairShotsWithPrompt(PLANNED, splitPromptShots(body))
  assert.equal(orphans.length, 0)
  assert.equal(pairs[2].shot.covers, 'he appears in the doorway and does not come in')
  assert.match(pairs[2].fragment!.text, /c/)
  // The mismatch is still visible, just not by mangling the pairing.
  assert.deepEqual(promptShotIssues(splitPromptShots(body)).numbering, [4, 5])
})

test('a planned shot with no fragment pairs to null — the plan and the prompt have drifted', () => {
  const { pairs } = pairShotsWithPrompt(PLANNED, splitPromptShots('[Shot 1] a\n[Shot 2] At 00:04.500, b'))
  assert.equal(pairs.length, 4)
  assert.ok(pairs[1].fragment)
  assert.equal(pairs[2].fragment, null)
  assert.equal(pairs[3].fragment, null)
})

test('a prompt with more shots than the plan reports the extras as orphans', () => {
  const { pairs, orphans } = pairShotsWithPrompt(PLANNED.slice(0, 2), splitPromptShots(BODY))
  assert.equal(pairs.length, 2)
  assert.equal(orphans.length, 2)
  assert.equal(orphans[0].n, 3)
})
