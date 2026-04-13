/**
 * Functional API Test Suite
 *
 * Tests real API endpoints against the deployed app.
 * Not code review — actual HTTP requests verifying actual responses.
 *
 * Run: npx tsx test-functional.ts
 */

const BASE = process.env.API_URL || 'https://mariamessaging.up.railway.app/api'
let TOKEN = ''
let passed = 0
let failed = 0
const failures: string[] = []

async function req(method: string, path: string, body?: any): Promise<{ status: number, data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  } catch (err: any) {
    return { status: 0, data: { error: err.message } }
  }
}

function test(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    const msg = detail ? `${name}: ${detail}` : name
    failures.push(msg)
    console.log(`  ✗ ${msg}`)
  }
}

async function run() {
  console.log('=== Maria Functional API Tests ===\n')
  console.log(`Target: ${BASE}\n`)

  // ─── Auth ─────────────────────────────────────
  console.log('AUTH:')

  const noAuth = await req('GET', '/partner/status')
  test('Unauthenticated /partner/status returns 401', noAuth.status === 401)

  const badLogin = await req('POST', '/auth/login', { username: 'fake', password: 'fake' })
  test('Bad credentials return error', badLogin.status !== 200)

  const login = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' })
  test('Admin login succeeds', login.status === 200 && !!login.data.token)
  TOKEN = login.data.token || ''

  const me = await req('GET', '/auth/me')
  test('/auth/me returns user', me.status === 200 && me.data.user?.username === 'admin')

  // ─── Partner Status ───────────────────────────
  console.log('\nPARTNER STATUS:')

  const status = await req('GET', '/partner/status')
  test('Partner status returns 200', status.status === 200)
  test('Has username', !!status.data.username)
  test('Has introduced field', typeof status.data.introduced === 'boolean')
  test('Has introStep field', typeof status.data.introStep === 'number')

  // ─── Partner History ──────────────────────────
  console.log('\nPARTNER HISTORY:')

  const history = await req('GET', '/partner/history')
  test('Partner history returns 200', history.status === 200)
  test('Messages is an array', Array.isArray(history.data.messages))

  // ─── Offerings ────────────────────────────────
  console.log('\nOFFERINGS:')

  const offerings = await req('GET', '/offerings')
  test('Offerings returns 200', offerings.status === 200)
  test('Offerings is array', Array.isArray(offerings.data.offerings))

  if (offerings.data.offerings?.length > 0) {
    const off = offerings.data.offerings[0]
    test('First offering has name', !!off.name)
    test('First offering has elements array', Array.isArray(off.elements))

    if (off.elements?.length > 0) {
      test('Elements have text field', !!off.elements[0].text)
      test('Elements have motivatingFactor field', typeof off.elements[0].motivatingFactor === 'string',
        `Got: ${typeof off.elements[0].motivatingFactor}`)
    }
  }

  // ─── Audiences ────────────────────────────────
  console.log('\nAUDIENCES:')

  const audiences = await req('GET', '/audiences')
  test('Audiences returns 200', audiences.status === 200)
  test('Audiences is array', Array.isArray(audiences.data.audiences))

  if (audiences.data.audiences?.length > 0) {
    const aud = audiences.data.audiences[0]
    test('First audience has name', !!aud.name)
    test('First audience has priorities', Array.isArray(aud.priorities))

    if (aud.priorities?.length > 0) {
      test('Priorities have text', !!aud.priorities[0].text)
      test('Priorities have driver field', typeof aud.priorities[0].driver === 'string')
    }
  }

  // ─── Drafts ───────────────────────────────────
  console.log('\nDRAFTS:')

  const drafts = await req('GET', '/drafts')
  test('Drafts returns 200', drafts.status === 200)
  test('Drafts is array', Array.isArray(drafts.data.drafts))

  let completeDraftId = ''
  if (drafts.data.drafts?.length > 0) {
    const completeDraft = drafts.data.drafts.find((d: any) => d.currentStep >= 5)
    if (completeDraft) {
      completeDraftId = completeDraft.id
      test('Found a completed draft', true)

      const detail = await req('GET', `/drafts/${completeDraftId}`)
      test('Draft detail returns 200', detail.status === 200)
      test('Has tier1Statement', !!detail.data.draft?.tier1Statement)
      test('Has tier2Statements array', Array.isArray(detail.data.draft?.tier2Statements))
      test('Tier2 has entries', detail.data.draft?.tier2Statements?.length > 0)

      if (detail.data.draft?.tier2Statements?.length > 0) {
        const t2 = detail.data.draft.tier2Statements[0]
        test('Tier2 has text', !!t2.text)
        test('Tier2 has tier3Bullets', Array.isArray(t2.tier3Bullets))
      }
    } else {
      test('Found a completed draft', false, 'No completed drafts exist')
    }
  }

  // ─── Hierarchy ────────────────────────────────
  console.log('\nHIERARCHY:')

  const hierarchy = await req('GET', '/drafts/hierarchy')
  test('Hierarchy returns 200', hierarchy.status === 200)
  test('Hierarchy is array', Array.isArray(hierarchy.data.hierarchy))

  if (hierarchy.data.hierarchy?.length > 0) {
    const h = hierarchy.data.hierarchy[0]
    test('Hierarchy offering has name', !!h.name)
    test('Hierarchy has audiences array', Array.isArray(h.audiences))

    if (h.audiences?.length > 0) {
      const a = h.audiences[0]
      test('Hierarchy audience has threeTier', !!a.threeTier)
      test('ThreeTier has tier1Text field', a.threeTier?.tier1Text !== undefined)
      test('ThreeTier has updatedAt field', !!a.threeTier?.updatedAt)
    }
  }

  // ─── Versions ─────────────────────────────────
  console.log('\nVERSIONS:')

  if (completeDraftId) {
    const versions = await req('GET', `/versions/table/${completeDraftId}`)
    test('Table versions returns 200', versions.status === 200)
    test('Versions is array', Array.isArray(versions.data.versions))
  }

  // ─── Stories ──────────────────────────────────
  console.log('\nSTORIES:')

  if (completeDraftId) {
    const stories = await req('GET', `/stories?draftId=${completeDraftId}`)
    test('Stories returns 200', stories.status === 200)
    test('Stories is array', Array.isArray(stories.data.stories))
  }

  // ─── Polish ───────────────────────────────────
  console.log('\nPOLISH:')

  if (completeDraftId) {
    const polish = await req('POST', '/ai/polish', { draftId: completeDraftId })
    test('Polish endpoint returns 200', polish.status === 200)
    test('Polish has suggestions array', Array.isArray(polish.data.suggestions))
  }

  // ─── Partner Message (read_page) ──────────────
  console.log('\nPARTNER MESSAGE:')

  const msg = await req('POST', '/partner/message', {
    message: 'What page am I on?',
    context: { page: 'dashboard' },
  })
  test('Partner message returns 200', msg.status === 200, `Got: ${msg.status}`)
  test('Response has text', !!msg.data.response)
  test('refreshNeeded is boolean', typeof msg.data.refreshNeeded === 'boolean')

  // ─── Frontend Loads ───────────────────────────
  console.log('\nFRONTEND:')

  const htmlRes = await fetch('https://mariamessaging.up.railway.app/')
  const html = await htmlRes.text()
  test('Homepage returns 200', htmlRes.status === 200)
  test('HTML contains app root', html.includes('id="root"'))
  test('HTML references JS bundle', html.includes('.js'))
  test('HTML references CSS bundle', html.includes('.css'))

  // ─── Summary ──────────────────────────────────
  console.log(`\n${'='.repeat(50)}`)
  console.log(`PASSED: ${passed}  FAILED: ${failed}`)
  if (failures.length > 0) {
    console.log('\nFAILURES:')
    failures.forEach(f => console.log(`  ✗ ${f}`))
  }
  console.log('')
}

run().catch(console.error)
