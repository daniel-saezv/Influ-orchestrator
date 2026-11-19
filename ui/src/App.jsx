import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  Clapperboard,
  Flame,
  History,
  Inbox,
  LoaderCircle,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  Sparkles,
  Sun,
  Upload,
  UserRound,
  X,
  Zap,
} from 'lucide-react'
import realApi, { sha256Hex } from './api/api.js'
import { Badge } from './components/ui/badge.jsx'
import { Button } from './components/ui/button.jsx'
import { Field, FieldDescription, FieldLabel } from './components/ui/field.jsx'
import { Progress } from './components/ui/progress.jsx'
import { Skeleton } from './components/ui/skeleton.jsx'
import { Textarea } from './components/ui/textarea.jsx'
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group.jsx'
import { applyTheme, readTheme, saveTheme } from './lib/theme.js'

const PLATFORMS = ['YouTube', 'Instagram', 'TikTok']
const days = (count) => `${count} ${count === 1 ? 'día' : 'días'}`
const platformLabel = (value) => String(value).split(',').map((item) => PLATFORMS.find((name) => name.toLowerCase() === item.trim().toLowerCase()) ?? item.trim()).join(', ')
const MAX_FILE_BYTES = 150 * 1024 * 1024
const PART_BYTES = 5 * 1024 * 1024
const UPLOAD_KEY = 'influ-upload-session'
const SAFE_PREVIEW_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
])
const TABS = [
  { id: 'studio', label: 'Estudio', icon: Clapperboard },
  { id: 'history', label: 'Historial', icon: History },
  { id: 'profile', label: 'Tú', icon: UserRound },
]
const STAGES = [
  { id: 'queued', label: 'Recibido' },
  { id: 'preparing', label: 'En montaje' },
  { id: 'ready', label: 'Listo para mirar' },
]

const tap = () => window.navigator.vibrate?.(8)

function Wordmark() {
  return (
    <span className="wordmark" aria-label="Influe">
      <span aria-hidden="true" className="wordmark-i">ı<span className="rec-dot" /></span>
      <span aria-hidden="true">nflue</span>
    </span>
  )
}

function TopBar({ onBack }) {
  return (
    <header className="topbar">
      {onBack ? (
        <Button variant="ghost" size="icon" aria-label="Volver" className="back-button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
      ) : <Wordmark />}
      <span className="mock-pill"><span className="mock-dot" aria-hidden="true" />Simulación</span>
    </header>
  )
}

function Heading({ eyebrow, children }) {
  return (
    <div className="heading">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{children}</h1>
    </div>
  )
}

function Section({ label, children, id }) {
  return (
    <section className="block" aria-labelledby={id}>
      <h2 className="block-label" id={id}>{label}</h2>
      {children}
    </section>
  )
}

function ErrorLine({ children }) {
  if (!children) return null
  return <p className="error" role="alert">{children}</p>
}

function PlatformChoices({ value, onChange }) {
  return (
    <ToggleGroup type="multiple" className="chips" value={value} onValueChange={(next) => { tap(); onChange(next) }} aria-label="Plataformas">
      {PLATFORMS.map((platform) => (
        <ToggleGroupItem key={platform} value={platform} className="chip">
          <span className={`platform-dot platform-${platform.toLowerCase()}`} aria-hidden="true" />
          {platform}
          <Check aria-hidden="true" className="chip-check" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function FilePreview({ file }) {
  const url = useMemo(() => {
    if (!file || !SAFE_PREVIEW_TYPES.has(file.type)) return ''
    const objectUrl = URL.createObjectURL(file)
    return new URL(objectUrl).protocol === 'blob:' ? encodeURI(objectUrl) : ''
  }, [file])
  useEffect(() => () => url && URL.revokeObjectURL(url), [url])
  if (!file) return null
  if (url && file.type.startsWith('video/')) {
    return <video className="thumb" src={url} playsInline muted />
  }
  if (url && file.type.startsWith('image/')) {
    return <img className="thumb" src={url} alt={`Vista previa de ${file.name}`} />
  }
  return <div className="thumb thumb-file"><Upload aria-hidden="true" /><span>{file.name}</span></div>
}

function PosterFrame({ note, version }) {
  return (
    <div className="poster">
      <span className="poster-light" aria-hidden="true" />
      <span className="poster-rec" aria-hidden="true"><span className="rec-dot" />REC</span>
      <p className="poster-title">{note?.trim() || 'Tu toma'}</p>
      <span className="poster-meta">Toma {version ?? 1} · 9:16</span>
    </div>
  )
}

function SwipeDeck({ disabled, onRight, onLeft, children }) {
  const [dx, setDx] = useState(0)
  const drag = useRef(null)
  const release = (event) => {
    const state = drag.current
    drag.current = null
    if (!state?.active) return
    const limit = event.currentTarget.offsetWidth * 0.28
    const distance = event.clientX - state.x
    setDx(0)
    if (distance > limit) onRight()
    else if (distance < -limit) onLeft()
  }
  const pull = Math.min(1, Math.abs(dx) / 120)
  return (
    <div
      className="deck"
      data-dragging={dx !== 0 ? 'true' : undefined}
      style={{ '--dx': `${dx}px` }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        drag.current = { x: event.clientX, y: event.clientY, active: false }
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (!state) return
        const moved = event.clientX - state.x
        if (!state.active) {
          if (Math.abs(event.clientY - state.y) > Math.abs(moved) + 4) {
            drag.current = null
            return
          }
          if (Math.abs(moved) < 12) return
          state.active = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
        setDx(moved)
      }}
      onPointerUp={release}
      onPointerCancel={() => {
        drag.current = null
        setDx(0)
      }}
    >
      <span className="deck-stamp deck-yes" aria-hidden="true" style={{ opacity: dx > 0 ? pull : 0 }}>Aprobar</span>
      <span className="deck-stamp deck-no" aria-hidden="true" style={{ opacity: dx < 0 ? pull : 0 }}>Cambiar</span>
      {children}
    </div>
  )
}

function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet-layer">
      <button type="button" className="sheet-scrim" aria-label="Cerrar" tabIndex={-1} onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id="sheet-title">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Cerrar" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Cargando">
      <Skeleton className="h-16 w-full rounded-2xl" />
      <Skeleton className="h-16 w-full rounded-2xl" />
      <Skeleton className="h-16 w-4/5 rounded-2xl" />
    </div>
  )
}

function CtaLabel({ children, icon: Icon = ArrowRight, busy }) {
  return (
    <>
      <span>{children}</span>
      <span className="cta-orb" aria-hidden="true">
        {busy ? <LoaderCircle className="spin" /> : <Icon />}
      </span>
    </>
  )
}

function useThemePreference() {
  const [preference, setPreference] = useState(readTheme)
  useEffect(() => {
    applyTheme(preference)
    if (preference !== 'system') return undefined
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    media?.addEventListener?.('change', onChange)
    return () => media?.removeEventListener?.('change', onChange)
  }, [preference])
  const update = useCallback((next) => {
    if (!next) return
    saveTheme(next)
    setPreference(next)
  }, [])
  return [preference, update]
}

function App({ api = realApi }) {
  const [screen, setScreen] = useState('loading')
  const [direction, setDirection] = useState('forward')
  const [me, setMe] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState(null)
  const [name, setName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accountId, setAccountId] = useState(null)
  const [streaks, setStreaks] = useState({})
  const [activity, setActivity] = useState(null)
  const [kind, setKind] = useState('from_scratch')
  const [note, setNote] = useState('')
  const [files, setFiles] = useState([])
  const [platforms, setPlatforms] = useState(['YouTube'])
  const [encargo, setEncargo] = useState(null)
  const [approved, setApproved] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [preview, setPreview] = useState(null)
  const [posterOnly, setPosterOnly] = useState(false)
  const [changeOpen, setChangeOpen] = useState(false)
  const [changeNote, setChangeNote] = useState('')
  const [scheduleMode, setScheduleMode] = useState('now')
  const [scheduleAt, setScheduleAt] = useState('')
  const [result, setResult] = useState(null)
  const [theme, setTheme] = useThemePreference()
  const installed = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const account = me?.accounts.find((item) => item.id === accountId) ?? null

  const go = useCallback((next, to = 'forward') => {
    setDirection(to)
    setError('')
    setScreen(next)
    window.scrollTo?.({ top: 0 })
  }, [])

  const notify = useCallback((message, tone = 'ok') => {
    setToast({ message, tone, id: Date.now() })
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const run = useCallback(async (label, operation) => {
    setBusy(label)
    setError('')
    try {
      const response = await operation()
      if (!response.ok) throw new Error(response.error.message)
      return response.data
    } catch (cause) {
      setError(cause.message || 'No he podido hacerlo. Inténtalo otra vez.')
      return null
    } finally {
      setBusy('')
    }
  }, [])

  const loadStreaks = useCallback(async (accounts) => {
    const pairs = await Promise.all(accounts.map(async (item) => {
      const response = await api.getStreak(item.id)
      return [item.id, response.ok ? response.data.days : 0]
    }))
    setStreaks((current) => ({ ...current, ...Object.fromEntries(pairs) }))
  }, [api])

  const adoptMe = useCallback((data) => {
    setMe(data)
    setAccountId((current) => (data.accounts.some((item) => item.id === current) ? current : data.accounts[0]?.id ?? null))
    loadStreaks(data.accounts)
  }, [loadStreaks])

  const enter = useCallback((response) => {
    if (!response.ok) {
      setError(response.error.message)
      setScreen('offline')
      return
    }
    adoptMe(response.data)
    setScreen(response.data.needs_guide ? 'welcome' : 'studio')
  }, [adoptMe])

  const loadMe = useCallback(() => api.getMe().then(enter), [api, enter])

  useEffect(() => {
    api.getMe().then(enter)
  }, [api, enter])

  useEffect(() => {
    if (screen !== 'history' || !accountId) return undefined
    let stopped = false
    api.getActivity(accountId).then((response) => {
      if (stopped) return
      if (response.ok) setActivity(response.data.items)
      else {
        setActivity([])
        setError(response.error.message)
      }
    })
    return () => {
      stopped = true
    }
  }, [api, screen, accountId])

  const openTab = (tab) => {
    if (tab === screen) return
    const order = TABS.map((item) => item.id)
    if (tab === 'history') setActivity(null)
    if (tab === 'profile') setName(me?.display_name ?? '')
    go(tab, order.indexOf(tab) < order.indexOf(screen) ? 'back' : 'forward')
  }

  const welcome = async (event) => {
    event.preventDefault()
    const data = await run('welcome', () => api.createMe({ display_name: name.trim(), time_zone: timeZone }))
    if (!data) return
    adoptMe(data)
    setName('')
    tap()
    go('studio')
  }

  const rename = async (event) => {
    event.preventDefault()
    const next = name.trim()
    const previous = me.display_name
    if (!next || next === previous) return
    setMe((current) => ({ ...current, display_name: next }))
    const response = await api.updateMe({ display_name: next })
    if (!response.ok) {
      setMe((current) => ({ ...current, display_name: previous }))
      notify(response.error.message, 'error')
      return
    }
    notify('Nombre guardado')
  }

  const addAccount = async (event) => {
    event.preventDefault()
    const label = accountName.trim()
    if (!label) return
    const temp = { id: `pendiente-${Date.now()}`, name: label, pending: true }
    const previous = accountId
    setMe((current) => ({ ...current, accounts: [...current.accounts, temp] }))
    setAccountId(temp.id)
    setAccountName('')
    const response = await api.createAccount({ name: label })
    if (!response.ok) {
      setMe((current) => ({ ...current, accounts: current.accounts.filter((item) => item.id !== temp.id) }))
      setAccountId(previous)
      notify(response.error.message, 'error')
      return
    }
    const created = { ...temp, ...response.data, pending: false }
    setMe((current) => ({ ...current, accounts: current.accounts.map((item) => (item.id === temp.id ? created : item)) }))
    setAccountId(created.id)
    setStreaks((current) => ({ ...current, [created.id]: 0 }))
    notify(`Cuenta «${created.name}» lista`)
    const refreshed = await api.getMe()
    if (refreshed.ok) setMe(refreshed.data)
  }

  const fail = (message, back = 'studio') => {
    setUploading(false)
    go(back, 'back')
    setError(message)
  }

  const createEncargo = async () => {
    if (!account || account.pending) return
    if (kind === 'edit' && files.some((file) => file.size > MAX_FILE_BYTES)) {
      setError('Ese archivo supera los 150 MB. Elige uno más pequeño.')
      return
    }
    tap()
    setApproved(false)
    setPreview(null)
    setPosterOnly(false)
    setUploadProgress(0)
    setUploading(kind === 'edit')
    go('preparing')
    const created = await api.createEncargo({
      account_id: account.id,
      kind,
      note,
      platforms: platforms.map((platform) => platform.toLowerCase()),
    })
    if (!created.ok) {
      fail(created.error.message)
      return
    }
    let activeEncargo = created.data
    setEncargo(activeEncargo)
    if (kind === 'edit') {
      const totalParts = files.reduce((sum, file) => sum + Math.max(1, Math.ceil(file.size / PART_BYTES)), 0)
      let sentParts = 0
      for (const [fileIndex, source] of files.entries()) {
        const interruptedId = fileIndex === 0 ? window.localStorage.getItem(UPLOAD_KEY) : null
        const sourceSha256 = await sha256Hex(source)
        const uploadBody = {
          encargo_id: activeEncargo.id,
          size_bytes: source.size,
          mime: source.type || 'application/octet-stream',
          sha256: sourceSha256,
        }
        let upload = await api.createUpload({ ...uploadBody, resume_id: interruptedId })
        if (!upload.ok && interruptedId) {
          window.localStorage.removeItem(UPLOAD_KEY)
          upload = await api.createUpload(uploadBody)
        }
        if (!upload.ok) {
          fail(upload.error.message)
          return
        }
        if (upload.data.resumed && upload.data.encargo_id && upload.data.encargo_id !== activeEncargo.id) {
          await api.cancelEncargo(activeEncargo.id)
          const resumed = await api.getEncargo(upload.data.encargo_id)
          if (!resumed.ok) {
            fail(resumed.error.message)
            return
          }
          activeEncargo = resumed.data
          setEncargo(activeEncargo)
        }
        const uploadSessionId = upload.data.upload_id
        window.localStorage.setItem(UPLOAD_KEY, uploadSessionId)
        const partCount = Math.ceil(source.size / PART_BYTES)
        const uploadedParts = new Set(upload.data.uploaded_parts ?? [])
        for (let index = 0; index < partCount; index += 1) {
          if (!uploadedParts.has(index + 1)) {
            const start = index * PART_BYTES
            const part = source.slice(start, Math.min(start + PART_BYTES, source.size))
            const uploaded = await api.uploadPart(uploadSessionId, index + 1, part)
            if (!uploaded.ok) {
              fail(uploaded.error.message)
              return
            }
          }
          sentParts += 1
          setUploadProgress(Math.round((sentParts / totalParts) * 100))
        }
        const completed = await api.completeUpload(uploadSessionId, { sha256: sourceSha256 })
        if (!completed.ok) {
          fail(completed.error.message)
          return
        }
        window.localStorage.removeItem(UPLOAD_KEY)
      }
      setUploading(false)
    }
  }

  const encargoId = encargo?.id

  useEffect(() => {
    if (screen !== 'preparing' || !encargoId || uploading) return undefined
    let stopped = false
    const poll = async () => {
      if (document.visibilityState !== 'visible' || stopped) return
      const response = await api.getEncargo(encargoId)
      if (!response.ok || stopped) return
      setEncargo(response.data)
      if (response.data.status === 'ready') {
        const media = await api.getMedia(response.data.result_sha256)
        if (stopped) return
        if (media.ok) setPreview(media.data)
        tap()
        go('preview')
      }
    }
    poll()
    const timer = window.setInterval(poll, 15_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [api, screen, encargoId, uploading, go])

  useEffect(() => {
    const url = preview?.url
    return () => {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    }
  }, [preview])

  const approveAndSchedule = async () => {
    if (!encargo || busy) return
    if (scheduleMode === 'at' && !scheduleAt) {
      setError('Elige día y hora antes de programar.')
      return
    }
    tap()
    setBusy('approve')
    setError('')
    if (!approved) {
      const decision = await api.decideEncargo(encargo.id, {
        decision: 'approve',
        version: encargo.version,
        content_hash: encargo.result_sha256,
      })
      if (!decision.ok) {
        setBusy('')
        setError(decision.error.message)
        return
      }
      setApproved(true)
    }
    const scheduled = await api.scheduleEncargo(encargo.id, {
      when: scheduleMode === 'at' ? new Date(scheduleAt).toISOString() : 'now',
    })
    if (!scheduled.ok) {
      setBusy('')
      setError(scheduled.error.message)
      return
    }
    const receipt = { ...encargo, ...scheduled.data, id: encargo.id, platforms: scheduled.data.platforms ?? encargo.platforms }
    setResult(receipt)
    setEncargo(receipt)
    const nextStreak = await api.getStreak(account.id)
    if (nextStreak.ok) setStreaks((current) => ({ ...current, [account.id]: nextStreak.data.days }))
    setBusy('')
    go('done')
  }

  const requestChanges = async (event) => {
    event.preventDefault()
    const changed = await run('change', () => api.decideEncargo(encargo.id, {
      decision: 'changes',
      version: encargo.version,
      content_hash: encargo.result_sha256,
      note: changeNote,
    }))
    if (!changed) return
    setEncargo({ ...encargo, ...changed, id: changed.id ?? encargo.id })
    setApproved(false)
    setPreview(null)
    setPosterOnly(false)
    setChangeNote('')
    setChangeOpen(false)
    go('preparing', 'back')
  }

  const startOver = (target = 'studio') => {
    setKind('from_scratch')
    setNote('')
    setFiles([])
    setPlatforms(['YouTube'])
    setEncargo(null)
    setApproved(false)
    setPreview(null)
    setResult(null)
    setScheduleMode('now')
    setScheduleAt('')
    setUploadProgress(0)
    if (target === 'history') setActivity(null)
    go(target, 'back')
  }

  const ready = Boolean(account && !account.pending && platforms.length && (kind === 'edit' ? files.length : note.trim()))
  const tabbed = TABS.some((tab) => tab.id === screen)

  let view
  let cta = null

  if (screen === 'loading') view = (
    <>
      <TopBar />
      <div className="heading" aria-busy="true">
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="mt-4 h-12 w-4/5 rounded-xl" />
        <Skeleton className="mt-2 h-12 w-3/5 rounded-xl" />
      </div>
      <p className="sr-only" role="status">Abriendo el camerino…</p>
      <ListSkeleton />
    </>
  )

  if (screen === 'offline') view = (
    <>
      <TopBar />
      <Heading eyebrow="Sin conexión">No encuentro <em>el camerino.</em></Heading>
      <ErrorLine>{error}</ErrorLine>
      <p className="lead">La sesión se protege con Cloudflare Access. Si acabas de entrar, vuelve a intentarlo.</p>
      <Button size="lg" className="cta" onClick={() => { setScreen('loading'); loadMe() }}><CtaLabel icon={RotateCcw}>Reintentar</CtaLabel></Button>
    </>
  )

  if (screen === 'welcome') view = (
    <>
      <TopBar />
      <Heading eyebrow="Primera visita">Tu camerino <em>está listo.</em></Heading>
      <ol className="reel" aria-label="Cómo funciona">
        <li><span>01</span><p>Me cuentas una idea o me pasas tus tomas.</p></li>
        <li><span>02</span><p>Miras la previa en vertical.</p></li>
        <li><span>03</span><p>Apruebas y queda programado.</p></li>
      </ol>
      <form className="stack" onSubmit={welcome} id="welcome-form">
        <Field>
          <FieldLabel htmlFor="name">Nombre</FieldLabel>
          <input id="name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder="¿Cómo te llamas?" />
          <FieldDescription>Zona horaria del teléfono: {timeZone}</FieldDescription>
        </Field>
        <ErrorLine>{error}</ErrorLine>
      </form>
      <p className="fine">Es una simulación: nada sale a redes reales.</p>
    </>
  )
  if (screen === 'welcome') cta = (
    <Button size="lg" className="cta" type="submit" form="welcome-form" disabled={!name.trim() || busy === 'welcome'}>
      <CtaLabel busy={busy === 'welcome'}>Empezar</CtaLabel>
    </Button>
  )

  if (screen === 'studio') view = (
    <>
      <TopBar />
      <Heading eyebrow={me?.display_name ? `Hola, ${me.display_name}` : 'Hola'}>¿Qué <em>grabamos</em> hoy?</Heading>
      <Section label="Cuenta" id="label-account">
        <div className="chip-row">
          <ToggleGroup type="single" className="chips" value={accountId ?? ''} onValueChange={(value) => { if (value) { tap(); setAccountId(value) } }} aria-label="Cuenta">
            {me?.accounts.map((item) => (
              <ToggleGroupItem key={item.id} value={item.id} className="chip" disabled={item.pending}>
                {item.name}
                <span className="streak" aria-label={`racha de ${days(streaks[item.id] ?? 0)}`}><Flame aria-hidden="true" />{streaks[item.id] ?? '·'}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button variant="ghost" size="icon" className="chip-add" aria-label="Nueva cuenta" onClick={() => openTab('profile')}><Plus aria-hidden="true" /></Button>
        </div>
      </Section>
      <Section label="Punto de partida" id="label-kind">
        <ToggleGroup type="single" className="segmented" value={kind} onValueChange={(value) => { if (value) { tap(); setKind(value) } }} aria-label="Punto de partida">
          <ToggleGroupItem value="from_scratch" className="segment"><Sparkles aria-hidden="true" />Una idea</ToggleGroupItem>
          <ToggleGroupItem value="edit" className="segment"><Upload aria-hidden="true" />Mis archivos</ToggleGroupItem>
        </ToggleGroup>
        <div className="swap" key={kind}>
          {kind === 'from_scratch' ? (
            <Field>
              <FieldLabel htmlFor="note" className="sr-only">Tu idea</FieldLabel>
              <Textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} rows={4} placeholder="Quiero contar que…" />
              <FieldDescription>El resultado puede llevar aviso de ayuda de IA.</FieldDescription>
            </Field>
          ) : (
            <div className="stack">
              <label className="drop">
                <span className="drop-icon" aria-hidden="true"><Upload /></span>
                <span><strong>Elegir vídeo, audio o fotos</strong><small>Hasta 150 MB por archivo</small></span>
                <input type="file" accept="image/*,video/*,audio/*" multiple onChange={(event) => {
                  const chosen = Array.from(event.target.files || [])
                  if (chosen.some((file) => file.size > MAX_FILE_BYTES)) {
                    setError('Ese archivo supera los 150 MB. Elige uno más pequeño.')
                    setFiles([])
                    return
                  }
                  setError('')
                  setFiles(chosen)
                }} />
              </label>
              {files.length > 0 && <div className="thumbs">{files.map((file) => <FilePreview key={`${file.name}-${file.size}`} file={file} />)}</div>}
              {window.localStorage.getItem(UPLOAD_KEY) && <p className="fine">Hay una subida a medias. Elige exactamente los mismos archivos para continuar.</p>}
              <Field>
                <FieldLabel htmlFor="note">Indicaciones</FieldLabel>
                <Textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="Opcional. Por ejemplo: quita solo el principio" />
              </Field>
            </div>
          )}
        </div>
      </Section>
      <Section label="Dónde" id="label-platforms">
        <PlatformChoices value={platforms} onChange={setPlatforms} />
      </Section>
      <ErrorLine>{error}</ErrorLine>
      <p className="fine">Simuladores MOCK: nada sale a redes reales.</p>
    </>
  )
  if (screen === 'studio') cta = (
    <Button size="lg" className="cta" disabled={!ready} onClick={createEncargo}>
      <CtaLabel icon={Sparkles}>Preparar</CtaLabel>
    </Button>
  )

  if (screen === 'preparing') {
    const status = uploading ? 'uploading' : encargo?.status ?? 'queued'
    const stageIndex = Math.max(0, STAGES.findIndex((stage) => stage.id === status))
    const eyebrow = uploading ? `Subiendo · ${uploadProgress}%` : encargo?.version > 1 ? `Toma ${encargo.version}` : 'En marcha'
    view = (
      <>
        <TopBar />
        <Heading eyebrow={eyebrow}>Revelando <em>tu toma.</em></Heading>
        <div className="darkroom" aria-hidden="true">
          <span className="darkroom-frame"><Skeleton className="h-full w-full rounded-[inherit]" /></span>
          <span className="darkroom-rec"><span className="rec-dot" />REC</span>
        </div>
        <Progress value={uploading ? uploadProgress : [30, 66, 100][stageIndex]} aria-label="Preparando tu encargo" />
        <ol className="stages">
          {STAGES.map((stage, index) => (
            <li key={stage.id} data-state={uploading ? 'todo' : index < stageIndex ? 'done' : index === stageIndex ? 'now' : 'todo'}>
              <span className="stage-dot" aria-hidden="true">{index < stageIndex && !uploading ? <Check /> : null}</span>{stage.label}
            </li>
          ))}
        </ol>
        <p className="fine">Puedes dejarlo en segundo plano. Miro el estado cada 15 segundos, solo con la app visible.</p>
      </>
    )
  }

  if (screen === 'preview') {
    const synthetic = preview?.synthetic || preview?.contains_synthetic_media || encargo?.synthetic
    const playable = preview?.url && preview.content_type?.startsWith('video/') && !posterOnly
    view = (
      <>
        <TopBar />
        <Heading eyebrow={`Versión ${encargo?.version ?? 1}`}>Mira <em>lo que he preparado</em></Heading>
        <SwipeDeck disabled={Boolean(busy)} onRight={approveAndSchedule} onLeft={() => setChangeOpen(true)}>
          <div className="frame">
            {playable
              ? <video className="frame-media" src={preview.url} playsInline controls onError={() => setPosterOnly(true)} />
              : <PosterFrame note={encargo?.note ?? note} version={encargo?.version} />}
            {synthetic && <Badge variant="secondary" className="ai-note"><Sparkles aria-hidden="true" />Hecho con ayuda de IA</Badge>}
          </div>
        </SwipeDeck>
        <p className="fine swipe-hint" aria-hidden="true">Desliza → para aprobar · ← para pedir un cambio</p>
        <Section label="Cuándo" id="label-when">
          <ToggleGroup type="single" className="segmented" value={scheduleMode} onValueChange={(value) => { if (value) { tap(); setScheduleMode(value) } }} aria-label="Cuándo">
            <ToggleGroupItem value="now" className="segment"><Zap aria-hidden="true" />Ahora</ToggleGroupItem>
            <ToggleGroupItem value="at" className="segment"><CalendarClock aria-hidden="true" />Elegir hora</ToggleGroupItem>
          </ToggleGroup>
          {scheduleMode === 'at' && (
            <Field className="swap">
              <FieldLabel htmlFor="schedule-at" className="sr-only">Día y hora</FieldLabel>
              <input id="schedule-at" className="input" type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
              <FieldDescription>Zona horaria del teléfono: {timeZone}</FieldDescription>
            </Field>
          )}
        </Section>
        {!changeOpen && <ErrorLine>{error}</ErrorLine>}
        {changeOpen && (
          <Sheet title="¿Qué cambio?" onClose={() => setChangeOpen(false)}>
            <form className="stack" onSubmit={requestChanges}>
              <Field>
                <FieldLabel htmlFor="change">Cambio</FieldLabel>
                <Textarea id="change" autoFocus value={changeNote} onChange={(event) => setChangeNote(event.target.value)} rows={4} placeholder="Más corto, otro arranque, menos texto…" />
              </Field>
              <ErrorLine>{error}</ErrorLine>
              <Button size="lg" className="cta" type="submit" disabled={!changeNote.trim() || busy === 'change'}>
                <CtaLabel icon={RotateCcw} busy={busy === 'change'}>Volver a preparar</CtaLabel>
              </Button>
            </form>
          </Sheet>
        )}
      </>
    )
    cta = (
      <div className="cta-pair">
        <Button size="lg" className="cta" onClick={approveAndSchedule} disabled={Boolean(busy)}>
          <CtaLabel icon={Check} busy={busy === 'approve'}>{scheduleMode === 'at' ? 'Aprobar y programar' : 'Aprobar y publicar'}</CtaLabel>
        </Button>
        <Button size="lg" variant="outline" className="cta-secondary" onClick={() => setChangeOpen(true)} disabled={Boolean(busy)}>Pedir un cambio</Button>
      </div>
    )
  }

  if (screen === 'done') {
    const scheduledTime = result?.publish_at
      ? new Date(result.publish_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone })
      : 'Ahora'
    const later = scheduleMode === 'at'
    view = (
      <>
        <TopBar />
        <div className="confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <i key={index} />)}</div>
        <div className="stamp" aria-hidden="true"><Check /></div>
        <Heading eyebrow="Simulación terminada">¡Corten! <em>{later ? 'Queda programado.' : 'Está publicado.'}</em></Heading>
        <dl className="ticket">
          <div><dt>Plataformas</dt><dd>{platformLabel((result?.platforms ?? []).join(','))}</dd></div>
          <div><dt>Hora</dt><dd>{scheduledTime}</dd></div>
          <div><dt>Racha</dt><dd><Flame aria-hidden="true" />{days(streaks[account?.id] ?? 1)}</dd></div>
        </dl>
        {!installed && <p className="fine">Añádelo a la pantalla de inicio para abrir Influe como una app.</p>}
      </>
    )
    cta = (
      <div className="cta-pair">
        <Button size="lg" className="cta" onClick={() => startOver('studio')}><CtaLabel icon={Plus}>Crear otro</CtaLabel></Button>
        <Button size="lg" variant="outline" className="cta-secondary" onClick={() => startOver('history')}>Ver historial</Button>
      </div>
    )
  }

  if (screen === 'history') view = (
    <>
      <TopBar />
      <Heading eyebrow={account?.name}>Lo que <em>ha salido</em></Heading>
      {activity === null ? <ListSkeleton /> : activity.length === 0 ? (
        <div className="empty">
          <Inbox aria-hidden="true" />
          <p>Todavía no hay simulaciones.</p>
          <Button variant="outline" onClick={() => openTab('studio')}>Preparar la primera</Button>
        </div>
      ) : (
        <ul className="feed">
          {activity.map((item) => (
            <li key={item.id}>
              <span className={`platform-dot platform-${String(item.platform).split(',')[0].trim().toLowerCase()}`} aria-hidden="true" />
              <div>
                <strong>{platformLabel(item.platform)}</strong>
                <span>{new Date(item.published_at ?? item.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
              <code>{item.mock_id}</code>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine>{error}</ErrorLine>
    </>
  )

  if (screen === 'profile') view = (
    <>
      <TopBar />
      <Heading eyebrow="Ajustes">Tu <em>camerino</em></Heading>
      <Section label="Tu nombre" id="label-name">
        <form className="inline-form" onSubmit={rename}>
          <FieldLabel htmlFor="change-name" className="sr-only">Cambiar nombre</FieldLabel>
          <input id="change-name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          <Button type="submit" variant="outline" disabled={!name.trim() || name.trim() === me?.display_name}>Guardar</Button>
        </form>
      </Section>
      <Section label="Cuentas" id="label-accounts">
        <ul className="feed">
          {me?.accounts.map((item) => (
            <li key={item.id} data-pending={item.pending ? 'true' : undefined}>
              <span className="avatar" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span>
              <div><strong>{item.name}</strong><span>{item.pending ? 'Creando…' : `Racha de ${days(streaks[item.id] ?? 0)}`}</span></div>
              {item.id === accountId && <Check aria-label="Cuenta activa" />}
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={addAccount}>
          <FieldLabel htmlFor="account-name" className="sr-only">Nombre de la cuenta</FieldLabel>
          <input id="account-name" className="input" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Nueva cuenta" />
          <Button type="submit" disabled={!accountName.trim()}><Plus aria-hidden="true" />Crear cuenta</Button>
        </form>
      </Section>
      <Section label="Apariencia" id="label-theme">
        <ToggleGroup type="single" className="segmented" value={theme} onValueChange={setTheme} aria-label="Apariencia">
          <ToggleGroupItem value="system" className="segment"><Monitor aria-hidden="true" />Sistema</ToggleGroupItem>
          <ToggleGroupItem value="light" className="segment"><Sun aria-hidden="true" />Claro</ToggleGroupItem>
          <ToggleGroupItem value="dark" className="segment"><Moon aria-hidden="true" />Oscuro</ToggleGroupItem>
        </ToggleGroup>
      </Section>
      <p className="fine">Sesión protegida con Cloudflare Access. Todo funciona en modo simulado.</p>
    </>
  )

  if (!view) view = <><TopBar /><Heading>Algo salió mal</Heading><p className="lead">No he encontrado esta pantalla.</p></>

  return (
    <div className="app">
      <aside className="backdrop" aria-hidden="true">
        <span className="backdrop-mark">ı<span className="rec-dot" />nflue</span>
        <p>El camerino de tu influencer virtual. Ideas, tomas y aprobaciones, todo en simulación.</p>
      </aside>
      <main className="phone">
        <div className="view" key={screen} data-dir={direction}>{view}</div>
        {(cta || tabbed) && (
          <div className="dock">
            {cta}
            {tabbed && (
              <nav className="tabs" aria-label="Secciones">
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" className="tab" aria-current={screen === id ? 'page' : undefined} onClick={() => { tap(); openTab(id) }}>
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
        <div className="toast-slot" role="status" aria-live="polite">
          {toast && <p className="toast" data-tone={toast.tone} key={toast.id}>{toast.message}</p>}
        </div>
      </main>
    </div>
  )
}

export default App
