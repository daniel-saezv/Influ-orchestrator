import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CalendarDays, Check, Clock3, History, Plus, Sparkles, Upload, UserRound } from 'lucide-react'
import { fakeApi } from './api/fakeApi.js'
import { Button } from './components/ui/button.jsx'
import { Field, FieldDescription, FieldLabel } from './components/ui/field.jsx'
import { Progress } from './components/ui/progress.jsx'
import { Skeleton } from './components/ui/skeleton.jsx'
import { Textarea } from './components/ui/textarea.jsx'
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group.jsx'

const PLATFORMS = ['YouTube', 'Instagram', 'TikTok']
const MAX_FILE_BYTES = 150 * 1024 * 1024
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

function Shell({ eyebrow, title, children, footer, onBack }) {
  return (
    <main className="app-shell">
      <section className="screen">
        <header className="screen-header">
          {onBack ? (
            <Button variant="ghost" size="icon" aria-label="Volver" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : <span className="header-spacer" aria-hidden="true" />}
          <span className="brand">Influe</span>
          <span className="header-spacer" aria-hidden="true" />
        </header>
        <div className="screen-copy">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
        </div>
        <div className="screen-content">{children}</div>
        {footer && <footer className="screen-footer">{footer}</footer>}
      </section>
    </main>
  )
}

function Loading() {
  return (
    <div className="stack">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-3/4" />
    </div>
  )
}

function PlatformChoices({ value, onChange }) {
  return (
    <ToggleGroup type="multiple" value={value} onValueChange={onChange} aria-label="Plataformas">
      {PLATFORMS.map((platform) => (
        <ToggleGroupItem key={platform} value={platform}>
          <span className={`platform-dot platform-${platform.toLowerCase()}`} />
          {platform}
          {value.includes(platform) && <Check aria-hidden="true" data-icon="inline-end" />}
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
    return <video className="selected-preview" src={url} playsInline muted controls />
  }
  if (url && file.type.startsWith('image/')) {
    return <img className="selected-preview" src={url} alt={`Vista previa de ${file.name}`} />
  }
  return <div className="audio-preview"><Upload aria-hidden="true" /><span>{file.name}</span></div>
}

function App() {
  const [screen, setScreen] = useState('enter')
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [streak, setStreak] = useState(null)
  const [activity, setActivity] = useState([])
  const [editingName, setEditingName] = useState(false)
  const [kind, setKind] = useState('from_scratch')
  const [brief, setBrief] = useState('')
  const [extra, setExtra] = useState('')
  const [files, setFiles] = useState([])
  const [platforms, setPlatforms] = useState(['YouTube'])
  const [encargo, setEncargo] = useState(null)
  const [preview, setPreview] = useState(null)
  const [changeNote, setChangeNote] = useState('')
  const [scheduleMode, setScheduleMode] = useState('now')
  const [scheduleAt, setScheduleAt] = useState('')
  const [result, setResult] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [selectedStreaks, setSelectedStreaks] = useState({})
  const installed = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const run = useCallback(async (operation) => {
    setLoading(true)
    setError('')
    try {
      const response = await operation()
      if (!response.ok) throw new Error(response.error.message)
      return response.data
    } catch (cause) {
      setError(cause.message || 'No he podido hacerlo. Inténtalo otra vez.')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMe = useCallback(async () => {
    const data = await run(() => fakeApi.getMe())
    if (!data) return
    setMe(data)
    const streakPairs = await Promise.all(data.accounts.map(async (account) => {
      const response = await fakeApi.getStreak(account.id)
      return [account.id, response.ok ? response.data.days : 0]
    }))
    setSelectedStreaks(Object.fromEntries(streakPairs))
    setScreen(data.needs_guide ? 'guide' : 'accounts')
  }, [run])

  const chooseAccount = async (account) => {
    setSelectedAccount(account)
    const data = await run(() => fakeApi.getStreak(account.id))
    if (data) setStreak(data)
    setScreen('today')
  }

  const createEncargo = async () => {
    if (!selectedAccount) return
    let uploadSessionId
    if (kind === 'edit') {
      const total = files.reduce((sum, file) => sum + file.size, 0)
      if (files.some((file) => file.size > MAX_FILE_BYTES)) {
        setError('Ese archivo supera los 150 MB. Elige uno más pequeño.')
        return
      }
      const interruptedId = window.localStorage.getItem('influ-upload-session')
      const upload = await run(() => fakeApi.createUpload({
        name: files.map((file) => file.name).join(', '),
        size_bytes: total,
        mime: files[0]?.type || 'application/octet-stream',
        resume_id: interruptedId,
      }))
      if (!upload) return
      uploadSessionId = upload.id
      window.localStorage.setItem('influ-upload-session', uploadSessionId)
      const allBlobs = files.flatMap((file) => {
        const parts = []
        for (let offset = 0; offset < file.size; offset += 5 * 1024 * 1024) {
          parts.push(file.slice(offset, offset + 5 * 1024 * 1024))
        }
        return parts
      })
      const uploadedParts = new Set(upload.uploaded_parts ?? [])
      for (let index = 0; index < allBlobs.length; index += 1) {
        if (uploadedParts.has(index + 1)) continue
        const uploaded = await run(() => fakeApi.uploadPart(uploadSessionId, index + 1, allBlobs[index]))
        if (!uploaded) {
          setScreen('source')
          return
        }
        setUploadProgress(Math.round(((index + 1) / allBlobs.length) * 100))
      }
      const completed = await run(() => fakeApi.completeUpload(uploadSessionId))
      if (!completed) return
      window.localStorage.removeItem('influ-upload-session')
    }
    const created = await run(() => fakeApi.createEncargo({
      account_id: selectedAccount.id,
      kind,
      note: kind === 'from_scratch' ? brief : extra,
      platforms,
      upload_session_id: uploadSessionId,
      synthetic: kind === 'from_scratch',
    }))
    if (!created) return
    setEncargo(created)
    setScreen('preparing')
  }

  useEffect(() => {
    if (screen !== 'preparing' || !encargo) return undefined
    let stopped = false
    const poll = async () => {
      if (document.visibilityState !== 'visible' || stopped) return
      const response = await fakeApi.getEncargo(encargo.id)
      if (!response.ok || stopped) return
      setEncargo(response.data)
      if (response.data.status === 'ready') {
        const media = await fakeApi.getMedia(response.data.result_sha256)
        if (media.ok) setPreview(media.data)
        setScreen('preview')
      }
    }
    poll()
    const timer = window.setInterval(poll, 15_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [screen, encargo])

  const approve = async () => {
    const approved = await run(() => fakeApi.decideEncargo(encargo.id, {
      decision: 'approve',
      version: encargo.version,
      content_hash: encargo.result_sha256,
    }))
    if (approved) {
      setEncargo(approved)
      setScreen('when')
    }
  }

  const requestChanges = async () => {
    const changed = await run(() => fakeApi.decideEncargo(encargo.id, {
      decision: 'changes',
      version: encargo.version,
      content_hash: encargo.result_sha256,
      note: changeNote,
    }))
    if (changed) {
      setEncargo(changed)
      setChangeNote('')
      setScreen('preparing')
    }
  }

  const schedule = async () => {
    const scheduled = await run(() => fakeApi.scheduleEncargo(encargo.id, {
      mode: scheduleMode,
      publish_at: scheduleMode === 'at' ? new Date(scheduleAt).toISOString() : undefined,
      time_zone: timeZone,
    }))
    if (!scheduled) return
    setResult(scheduled)
    setEncargo(scheduled)
    const nextStreak = await fakeApi.getStreak(selectedAccount.id)
    if (nextStreak.ok) setStreak(nextStreak.data)
    setScreen('done')
  }

  const startOver = () => {
    setKind('from_scratch')
    setBrief('')
    setExtra('')
    setFiles([])
    setPlatforms(['YouTube'])
    setEncargo(null)
    setPreview(null)
    setResult(null)
    setUploadProgress(0)
    setScreen('accounts')
  }

  if (screen === 'enter') return (
    <Shell eyebrow="Tu espacio de creación" title="Hola. Vamos a preparar algo bonito." footer={
      <Button className="primary-action" size="lg" onClick={loadMe} disabled={loading}>Entrar</Button>
    }>
      <p className="lead">Ya hay una sesión fingida. En la fase G entrará Cloudflare Access.</p>
    </Shell>
  )

  if (screen === 'guide') return (
    <Shell eyebrow="Primera visita" title="Así de simple" footer={
      <Button className="primary-action" size="lg" onClick={() => setScreen('name')}>Empezar</Button>
    }>
      <ol className="guide-list">
        <li><span>1</span><p>Eliges qué quieres hacer.</p></li>
        <li><span>2</span><p>Miras la propuesta.</p></li>
        <li><span>3</span><p>Si te gusta, se deja programado. Todavía es una simulación.</p></li>
      </ol>
    </Shell>
  )

  if (screen === 'name') return (
    <Shell eyebrow="Para conocerte" title="¿Cómo te llamas?" footer={
      <Button className="primary-action" size="lg" disabled={!name.trim() || loading} onClick={async () => {
        const data = await run(() => fakeApi.createMe({ display_name: name, time_zone: timeZone }))
        if (data) {
          setMe(data)
          setName('')
          setScreen('accounts')
        }
      }}>Listo</Button>
    }>
      <Field>
        <FieldLabel htmlFor="name">Nombre</FieldLabel>
        <input id="name" className="input" autoFocus value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
        <FieldDescription>Zona horaria del teléfono: {timeZone}</FieldDescription>
      </Field>
      {error && <p className="error" role="alert">{error}</p>}
    </Shell>
  )

  if (screen === 'accounts') return (
    <Shell eyebrow={`Hola${me?.display_name ? `, ${me.display_name}` : ''}`} title="¿Con qué cuenta?" footer={
      <Button className="primary-action" variant="secondary" onClick={() => setScreen('activity')} disabled={!selectedAccount}>Qué ha pasado</Button>
    }>
      <div className="stack">
        {me?.accounts.map((account) => (
          <Button key={account.id} variant="outline" size="lg" className="account-button" onClick={() => chooseAccount(account)}>
            <span><UserRound aria-hidden="true" />{account.name}</span>
            <small>Racha: {selectedStreaks[account.id] ?? '…'} días</small>
          </Button>
        ))}
        {editingName === 'account' ? (
          <form className="inline-form" onSubmit={async (event) => {
            event.preventDefault()
            const created = await run(() => fakeApi.createAccount({ name: accountName }))
            if (created) {
              const response = await fakeApi.getMe()
              if (response.ok) setMe(response.data)
              setAccountName('')
              setEditingName(false)
            }
          }}>
            <Field><FieldLabel htmlFor="account-name">Nombre de la cuenta</FieldLabel><input id="account-name" className="input" value={accountName} onChange={(event) => setAccountName(event.target.value)} autoFocus required /></Field>
            <Button type="submit" disabled={loading}><Plus aria-hidden="true" data-icon="inline-start" />Crear cuenta</Button>
          </form>
        ) : <Button variant="ghost" onClick={() => setEditingName('account')}><Plus aria-hidden="true" data-icon="inline-start" />Nueva cuenta</Button>}
        {editingName === 'name' ? (
          <form className="inline-form" onSubmit={async (event) => {
            event.preventDefault()
            const data = await run(() => fakeApi.updateMe({ display_name: name }))
            if (data) {
              setMe(data)
              setEditingName(false)
              setName('')
            }
          }}>
            <Field><FieldLabel htmlFor="change-name">Cambiar nombre</FieldLabel><input id="change-name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus required /></Field>
            <Button type="submit" disabled={loading}>Guardar</Button>
          </form>
        ) : <Button variant="ghost" onClick={() => { setEditingName('name'); setName(me?.display_name || '') }}>Cambiar nombre</Button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </Shell>
  )

  if (screen === 'activity') return (
    <Shell eyebrow={selectedAccount?.name} title="Qué ha pasado" onBack={() => setScreen('accounts')} footer={
      <Button className="primary-action" size="lg" onClick={() => setScreen('accounts')}>Volver a mis cuentas</Button>
    }>
      {loading ? <Loading /> : <ActivityLoader account={selectedAccount} activity={activity} setActivity={setActivity} setError={setError} />}
    </Shell>
  )

  if (screen === 'today') return (
    <Shell eyebrow={selectedAccount?.name} title="¿Qué publicamos hoy?" onBack={() => setScreen('accounts')} footer={
      <p className="footer-note">Simulación: todavía no se publica de verdad.</p>
    }>
      {streak && <p className="streak"><Sparkles aria-hidden="true" />Racha: {streak.days} días seguidos</p>}
      <div className="choice-grid">
        <button className="choice-card" onClick={() => { setKind('from_scratch'); setScreen('brief') }}>
          <Sparkles aria-hidden="true" /><strong>Crear desde cero</strong><span>Dame una idea y la preparo.</span>
        </button>
        <button className="choice-card" onClick={() => { setKind('edit'); setScreen('source') }}>
          <Upload aria-hidden="true" /><strong>Editar mis vídeos</strong><span>Elige material propio.</span>
        </button>
      </div>
    </Shell>
  )

  if (screen === 'brief') return (
    <Shell eyebrow="Desde cero" title="¿Qué tienes en mente?" onBack={() => setScreen('today')} footer={
      <Button className="primary-action" size="lg" disabled={!brief.trim()} onClick={() => setScreen('platforms')}>Prepararlo</Button>
    }>
      <Field>
        <FieldLabel htmlFor="brief">Tu idea</FieldLabel>
        <Textarea id="brief" autoFocus value={brief} onChange={(event) => setBrief(event.target.value)} rows={7} placeholder="Quiero hablar de…" />
        <FieldDescription>Este resultado puede llevar aviso de ayuda de IA.</FieldDescription>
      </Field>
    </Shell>
  )

  if (screen === 'source') return (
    <Shell eyebrow="Tus archivos" title="¿Qué quieres editar?" onBack={() => setScreen('today')} footer={
      <Button className="primary-action" size="lg" disabled={!files.length} onClick={() => setScreen('extra')}>Seguir</Button>
    }>
      <label className="file-picker">
        <Upload aria-hidden="true" />
        <span>Elegir vídeo, audio o fotos</span>
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
      <div className="preview-list">{files.map((file) => <FilePreview key={`${file.name}-${file.size}`} file={file} />)}</div>
      {files.length > 0 && <p className="helper">Si iOS corta la subida, vuelve a elegir exactamente los mismos archivos.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {window.localStorage.getItem('influ-upload-session') && <p className="helper">Hay una subida a medias en este origen. Vuelve a elegir los mismos archivos para continuar.</p>}
    </Shell>
  )

  if (screen === 'extra') return (
    <Shell eyebrow="Opcional" title="¿Algo más?" onBack={() => setScreen('source')} footer={
      <Button className="primary-action" size="lg" onClick={() => setScreen('platforms')}>Prepararlo</Button>
    }>
      <Field>
        <FieldLabel htmlFor="extra">Indicaciones</FieldLabel>
        <Textarea id="extra" value={extra} onChange={(event) => setExtra(event.target.value)} rows={6} placeholder="Por ejemplo: quita solo el principio" />
        <FieldDescription>Puedes dejarlo vacío.</FieldDescription>
      </Field>
    </Shell>
  )

  if (screen === 'platforms') return (
    <Shell eyebrow="Último detalle" title="¿Dónde lo publicamos?" onBack={() => setScreen(kind === 'edit' ? 'extra' : 'brief')} footer={
      <Button className="primary-action" size="lg" disabled={!platforms.length || loading} onClick={createEncargo}>Seguir</Button>
    }>
      <PlatformChoices value={platforms} onChange={setPlatforms} />
      <p className="helper">Son simuladores MOCK. Nada sale a redes reales.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </Shell>
  )

  if (screen === 'preparing') return (
    <Shell eyebrow={encargo ? `Estado: ${encargo.status}` : ''} title="Lo estoy preparando.">
      <div className="preparing-state">
        <div className="orb"><Sparkles aria-hidden="true" /></div>
        <Progress value={uploadProgress || 58} aria-label="Preparando tu encargo" />
        <p>Sin decisión todavía. Puedes dejarlo en segundo plano.</p>
        <p className="helper">Compruebo el estado como mucho cada 15 segundos y solo con esta pestaña visible.</p>
      </div>
    </Shell>
  )

  if (screen === 'preview') return (
    <Shell eyebrow="Así queda" title="Mira lo que he preparado" footer={
      <div className="decision-footer">
        <Button className="primary-action" size="lg" onClick={approve} disabled={loading}>¡Me gusta!</Button>
        <Button className="primary-action" size="lg" variant="outline" onClick={() => setScreen('change')}>Cambiar algo</Button>
      </div>
    }>
      <div className="vertical-preview">
        {files[0]?.type.startsWith('video/') ? <FilePreview file={files[0]} /> : <div className="mock-video"><Sparkles aria-hidden="true" /><span>Previa 9:16</span></div>}
        <span className="preview-version">Versión {encargo?.version}</span>
      </div>
      {(preview?.synthetic || preview?.contains_synthetic_media || encargo?.synthetic) && <p className="ai-note">Hecho con ayuda de IA</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Shell>
  )

  if (screen === 'change') return (
    <Shell eyebrow="Me cuentas el cambio" title="¿Qué cambio?" onBack={() => setScreen('preview')} footer={
      <Button className="primary-action" size="lg" disabled={!changeNote.trim() || loading} onClick={requestChanges}>Volver a preparar</Button>
    }>
      <Field><FieldLabel htmlFor="change">Cambio</FieldLabel><Textarea id="change" autoFocus value={changeNote} onChange={(event) => setChangeNote(event.target.value)} rows={7} /></Field>
    </Shell>
  )

  if (screen === 'when') return (
    <Shell eyebrow="Aprobado" title="¿Cuándo?" onBack={() => setScreen('preview')} footer={
      <Button className="primary-action" size="lg" onClick={scheduleMode === 'at' ? () => setScreen('date') : schedule}>{
        scheduleMode === 'at' ? 'Elegir día y hora' : 'Listo'
      }</Button>
    }>
      <div className="stack">
        <button className={`schedule-choice ${scheduleMode === 'now' ? 'selected' : ''}`} onClick={() => setScheduleMode('now')}><Clock3 aria-hidden="true" /><span><strong>Ahora</strong><small>En esta simulación queda publicado.</small></span></button>
        <button className={`schedule-choice ${scheduleMode === 'at' ? 'selected' : ''}`} onClick={() => setScheduleMode('at')}><CalendarDays aria-hidden="true" /><span><strong>Elegir día y hora</strong><small>Se interpreta en tu zona horaria.</small></span></button>
      </div>
    </Shell>
  )

  if (screen === 'date') return (
    <Shell eyebrow="Programación" title="Día y hora" onBack={() => setScreen('when')} footer={
      <Button className="primary-action" size="lg" disabled={!scheduleAt || loading} onClick={schedule}>Programar</Button>
    }>
      <Field>
        <FieldLabel htmlFor="schedule-at">Cuándo</FieldLabel>
        <input id="schedule-at" className="input" type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
        <FieldDescription>Zona horaria del teléfono: {timeZone}</FieldDescription>
      </Field>
      {error && <p className="error" role="alert">{error}</p>}
    </Shell>
  )

  if (screen === 'done') {
    const scheduledTime = result?.publish_at ? new Date(result.publish_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone }) : 'Ahora'
    return (
      <Shell eyebrow="Simulación terminada" title="¡Listo!" footer={
        <Button className="primary-action" size="lg" onClick={startOver}>Crear otro</Button>
      }>
        <div className="success-mark"><Check aria-hidden="true" /></div>
        <div className="receipt">
          <p><span>Plataformas</span><strong>{result?.platforms.join(', ')}</strong></p>
          <p><span>Hora</span><strong>{scheduledTime}</strong></p>
          <p><span>Racha</span><strong>{streak?.days ?? 1} días</strong></p>
        </div>
        {!installed && <p className="install-line">Añadir a pantalla de inicio para abrir Influe como una app.</p>}
      </Shell>
    )
  }

  return <Shell title="Algo salió mal"><p>No he encontrado esta pantalla.</p></Shell>
}

function ActivityLoader({ account, activity, setActivity, setError }) {
  useEffect(() => {
    fakeApi.getActivity(account.id).then((response) => {
      if (response.ok) setActivity(response.data.items)
      else setError(response.error.message)
    })
  }, [account.id, setActivity, setError])

  if (!activity.length) return <p className="empty-state"><History aria-hidden="true" />Todavía no hay simulaciones.</p>
  return (
    <ul className="activity-list">
      {activity.map((item) => <li key={item.id}><div><strong>{item.platform}</strong><span>{new Date(item.published_at ?? item.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span></div><code>{item.mock_id}</code></li>)}
    </ul>
  )
}

export default App
