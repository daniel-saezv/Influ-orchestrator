import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  Clapperboard,
  Flame,
  GalleryHorizontalEnd,
  History,
  Image,
  Inbox,
  List,
  LoaderCircle,
  Monitor,
  MonitorPlay,
  Moon,
  Plus,
  RotateCcw,
  Smartphone,
  Sparkles,
  Sun,
  Upload,
  UserRound,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import realApi from './api/api.js'
import { hashFile } from './lib/hash-file.js'
import { uploadParts } from './lib/upload-parts.js'
import { Badge } from './components/ui/badge.jsx'
import { Button } from './components/ui/button.jsx'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty.jsx'
import { Field, FieldDescription, FieldLabel } from './components/ui/field.jsx'
import { Progress } from './components/ui/progress.jsx'
import { Skeleton } from './components/ui/skeleton.jsx'
import { Textarea } from './components/ui/textarea.jsx'
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group.jsx'
import { applyTheme, readTheme, saveTheme } from './lib/theme.js'

const PLATFORMS = ['YouTube', 'Instagram', 'TikTok']
const days = (count) => `${count} ${count === 1 ? 'día' : 'días'}`
const platformLabel = (value) => String(value).split(',').map((item) => PLATFORMS.find((name) => name.toLowerCase() === item.trim().toLowerCase()) ?? item.trim()).join(', ')
const FORMATS = [
  { id: 'image', label: 'Foto', hint: 'Una imagen', missing: 'No publica fotos', icon: Image },
  { id: 'carousel', label: 'Carrusel', hint: 'Varias fotos', missing: 'No publica carruseles', icon: GalleryHorizontalEnd },
  { id: 'short_video', label: 'Vídeo corto', hint: 'Vertical, hasta 3 min', missing: 'No publica vídeo corto', icon: Smartphone },
  { id: 'video', label: 'Vídeo', hint: 'Pieza larga', missing: 'No publica vídeo largo', icon: MonitorPlay },
]
const TARGETS = {
  image: [
    { id: 'instagram:feed', platform: 'instagram', label: 'Feed' },
    { id: 'instagram:story', platform: 'instagram', label: 'Story' },
    { id: 'tiktok:photo', platform: 'tiktok', label: 'Foto' },
  ],
  carousel: [
    { id: 'instagram:feed', platform: 'instagram', label: 'Carrusel' },
    { id: 'tiktok:photo', platform: 'tiktok', label: 'Carrusel' },
  ],
  short_video: [
    { id: 'youtube:short', platform: 'youtube', label: 'Short' },
    { id: 'instagram:reel', platform: 'instagram', label: 'Reel' },
    { id: 'instagram:story', platform: 'instagram', label: 'Story' },
    { id: 'tiktok:video', platform: 'tiktok', label: 'Vídeo' },
  ],
  video: [
    { id: 'youtube:video', platform: 'youtube', label: 'Vídeo' },
    { id: 'instagram:reel', platform: 'instagram', label: 'Reel' },
    { id: 'tiktok:video', platform: 'tiktok', label: 'Vídeo' },
  ],
}
const formatLabel = (format) => FORMATS.find((item) => item.id === format)?.label ?? 'Formato anterior'
const targetName = (choice) => `${platformLabel(choice.platform)} ${choice.label}`
function targetText(item) {
  if (!item?.format) return platformLabel((item?.platforms ?? []).join(',')) || 'Formato anterior'
  return (item.targets ?? []).map((target) => {
    const choice = TARGETS[item.format]?.find((entry) => entry.id === `${target.platform}:${target.target}`)
    return choice ? targetName(choice) : platformLabel(target.platform)
  }).join(', ')
}
function targetPlatforms(item) {
  const list = item?.format ? (item.targets ?? []).map((target) => target.platform) : (item?.platforms ?? [])
  return [...new Set(list.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
}
function keepOnePerNetwork(current, next) {
  const added = next.find((id) => !current.includes(id))
  if (!added) return next
  const platform = added.slice(0, added.indexOf(':'))
  return next.filter((id) => id === added || !id.startsWith(`${platform}:`))
}
const MAX_FILE_BYTES = 150 * 1024 * 1024
const PART_BYTES = 5 * 1024 * 1024
const UPLOAD_KEY = 'influ-upload-session'
const DRAFT_KEY = 'influ-studio-draft'
const QUEUE_BEATS = ['En cola, en silencio…', 'El cuarto oscuro se prepara…', 'Tu toma espera turno…']
const PREP_BEATS = ['Montando el ritmo…', 'Ajustando el encuadre…', 'Buscando el corte…', 'Afinando la luz…']
const NON_CANCELLABLE_ENCARGO_STATUSES = new Set(['cancelled', 'scheduled'])
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
  { id: 'encargos', label: 'Encargos', icon: List },
  { id: 'history', label: 'Historial', icon: History },
  { id: 'profile', label: 'Tú', icon: UserRound },
]
const STAGES = [
  { id: 'queued', label: 'En cola' },
  { id: 'preparing', label: 'En marcha' },
  { id: 'ready', label: 'Listo para revisar' },
]
const TRACKED_SCREENS = new Set(['preparing', 'preview', 'cancelled', 'done'])
const STATUS_LABELS = {
  draft: 'Borrador',
  queued: 'En cola',
  claimed: 'En marcha',
  preparing: 'En marcha',
  ready: 'Listo para revisar',
  approved: 'Aprobado',
  scheduled: 'Programado',
  cancelled: 'Cancelado',
  failed: 'Fallido',
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? 'En marcha'
}

function screenForStatus(status) {
  if (status === 'ready' || status === 'approved') return 'preview'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'scheduled') return 'done'
  return 'preparing'
}

function stageIndexFor(status) {
  if (status === 'claimed' || status === 'preparing') return 1
  if (status === 'ready' || status === 'approved' || status === 'scheduled') return 2
  return 0
}

function readRoute() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/encargos') return { name: 'encargos' }
  const match = /^\/encargos\/([^/]+)$/.exec(path)
  if (match) return { name: 'encargo', id: decodeURIComponent(match[1]) }
  return { name: 'home' }
}

function pathFor(screen, encargoId) {
  if (screen === 'encargos') return '/encargos'
  if (encargoId && TRACKED_SCREENS.has(screen)) return `/encargos/${encodeURIComponent(encargoId)}`
  return '/'
}

function formatWhen(value, timeZone) {
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'
  return date.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short', timeZone })
}

function encargoTitle(item) {
  const note = item?.note?.trim()
  if (note) return note.split('\n')[0]
  return item?.kind === 'edit' ? 'Archivos' : 'Una idea'
}

const tap = () => window.navigator.vibrate?.(8)

function motionOk() {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
}

function celebrate() {
  if (!motionOk()) {
    tap()
    return
  }
  window.navigator.vibrate?.([12, 36, 18])
}

function writeSession(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    return false
  }
  return true
}

function readStudioDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    const format = FORMATS.some((item) => item.id === data?.format) ? data.format : ''
    const allowed = new Set((TARGETS[format] ?? []).map((item) => item.id))
    const seen = new Set()
    const targets = []
    for (const id of Array.isArray(data?.targets) ? data.targets : []) {
      if (!allowed.has(id)) continue
      const platform = id.slice(0, id.indexOf(':'))
      if (seen.has(platform)) continue
      seen.add(platform)
      targets.push(id)
    }
    return {
      kind: data?.kind === 'edit' ? 'edit' : 'from_scratch',
      note: typeof data?.note === 'string' ? data.note.slice(0, 4000) : '',
      format,
      targets,
    }
  } catch {
    return null
  }
}

function useBeat(lines, active) {
  const signature = lines.join('\n')
  const [index, setIndex] = useState(0)
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setIndex(0)
  }
  useEffect(() => {
    if (!active || lines.length < 2) return undefined
    if (!motionOk()) return undefined
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      setIndex((current) => (current + 1) % lines.length)
    }, 3200)
    return () => window.clearInterval(id)
  }, [active, lines, signature])
  return lines[seen === signature ? index : 0] ?? ''
}

function Wordmark() {
  return (
    <span className="wordmark" aria-label="Influe">
      <span aria-hidden="true" className="wordmark-i">ı<span className="rec-dot" /></span>
      <span aria-hidden="true">nflue</span>
    </span>
  )
}

function TopBar({ onBack, backLabel = 'Volver' }) {
  return (
    <header className="topbar">
      {onBack ? (
        <Button variant="ghost" className="back-button back-text" onClick={onBack}>
          <ArrowLeft aria-hidden="true" data-icon="inline-start" />
          {backLabel}
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

function LoadError({ title, detail, onRetry }) {
  return (
    <Empty className="min-h-0 flex-none items-start rounded-2xl border border-dashed border-input p-6 text-left">
      <EmptyHeader className="items-start text-left">
        <EmptyMedia variant="icon"><XCircle /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="items-start">
        <Button variant="outline" onClick={onRetry}><RotateCcw aria-hidden="true" data-icon="inline-start" />Reintentar</Button>
      </EmptyContent>
    </Empty>
  )
}

function canCancelEncargo(status) {
  return Boolean(status) && !NON_CANCELLABLE_ENCARGO_STATUSES.has(status)
}

function CancelEncargoAction({ encargo, busy, onConfirm }) {
  const [confirming, setConfirming] = useState(false)
  if (!canCancelEncargo(encargo?.status)) return null
  const disabled = Boolean(busy)
  if (confirming) {
    return (
      <div className="cancel-confirm" role="alertdialog" aria-labelledby="cancel-title" aria-describedby="cancel-desc">
        <p id="cancel-title" className="cancel-confirm-title">¿Cancelar este encargo?</p>
        <p id="cancel-desc" className="fine">No se publicará y dejarás de trabajar en esta versión.</p>
        <div className="cancel-confirm-actions">
          <Button variant="outline" className="cta-secondary" onClick={() => setConfirming(false)} disabled={disabled}>No, seguir</Button>
          <Button variant="destructive" className="cta-secondary" onClick={onConfirm} disabled={disabled}>Sí, cancelar</Button>
        </div>
      </div>
    )
  }
  return (
    <Button variant="ghost" className="cancel-link" onClick={() => setConfirming(true)} disabled={disabled}>
      <XCircle aria-hidden="true" data-icon="inline-start" />
      Cancelar encargo
    </Button>
  )
}

function PlatformDots({ platforms }) {
  if (!platforms.length) return null
  return (
    <span className="platform-dots" aria-hidden="true">
      {platforms.map((platform) => <span key={platform} className={`platform-dot platform-${platform}`} />)}
    </span>
  )
}

function FitSummary({ item }) {
  const Icon = FORMATS.find((entry) => entry.id === item?.format)?.icon
  return (
    <span className="fit-line">
      {Icon && <Icon aria-hidden="true" />}
      {formatLabel(item?.format)} · <PlatformDots platforms={targetPlatforms(item)} />{targetText(item)}
    </span>
  )
}

function TicketFit({ item }) {
  const Icon = FORMATS.find((entry) => entry.id === item?.format)?.icon
  return (
    <>
      <div><dt>Formato</dt><dd>{Icon && <Icon aria-hidden="true" />}{formatLabel(item?.format)}</dd></div>
      <div className="ticket-wrap"><dt>Destinos</dt><dd><PlatformDots platforms={targetPlatforms(item)} />{targetText(item)}</dd></div>
    </>
  )
}

function FormatPicker({ format, targets, onFormat, onTargets }) {
  const ref = useRef(null)
  const current = FORMATS.find((item) => item.id === format)
  const choices = TARGETS[format] ?? []
  const pick = (next) => {
    if (!next) return
    tap()
    onFormat(next)
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    window.requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' }))
  }
  return (
    <div className="fit" ref={ref}>
      <ToggleGroup type="single" className="format-strip grid w-full grid-cols-4" value={format} onValueChange={pick} aria-label="Formato">
        {FORMATS.map((item) => {
          const Icon = item.icon
          return (
            <ToggleGroupItem key={item.id} value={item.id} className="format-tile">
              <Icon aria-hidden="true" />
              <span>{item.label}</span>
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>
      <div className="fit-panel" data-idle={current ? undefined : ''}>
        <p className="fit-head" key={`head-${format}`}>
          {current ? <><strong>{current.label}</strong><span>{current.hint}</span></> : <span>Elige un formato y aquí verás dónde sale.</span>}
        </p>
        <ToggleGroup type="multiple" className="nets w-full flex-col items-stretch" value={targets} onValueChange={(next) => { tap(); onTargets(keepOnePerNetwork(targets, next)) }} aria-label="Destinos" disabled={!current} key={`nets-${format}`}>
          {PLATFORMS.map((name) => {
            const platform = name.toLowerCase()
            const own = choices.filter((choice) => choice.platform === platform)
            return (
              <div className="net" key={platform} data-off={current && !own.length ? '' : undefined}>
                <span className="net-name"><span className={`platform-dot platform-${platform}`} aria-hidden="true" />{name}</span>
                <span className="net-choices">
                  {own.map((choice) => (
                    <ToggleGroupItem key={choice.id} value={choice.id} className="chip net-chip" aria-label={targetName(choice)}>
                      {choice.label}
                      <Check aria-hidden="true" className="chip-check" />
                    </ToggleGroupItem>
                  ))}
                  {current && !own.length && <span className="net-off">{current.missing}</span>}
                </span>
              </div>
            )
          })}
        </ToggleGroup>
      </div>
    </div>
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
    return <video className="thumb" src={url} playsInline muted preload="metadata" />
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

function previewFromEncargo(data) {
  const source = data?.preview
  if (!source?.media_url) return null
  const contentType = source.mime || source.content_type
  if (!contentType) return null
  return {
    sha256: source.sha256 ?? data.result_sha256,
    content_type: contentType,
    url: source.media_url,
  }
}

function encargoNeedsRefresh(current, next) {
  if (!current || !next) return Boolean(next)
  return current.updated_at !== next.updated_at
    || current.status !== next.status
    || current.version !== next.version
    || current.result_sha256 !== next.result_sha256
    || current.publish_at !== next.publish_at
}

function previewMediaKind(contentType) {
  const type = String(contentType ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return null
}

function FramePreview({ preview, posterOnly, onMediaError, note, version }) {
  const kind = !posterOnly && preview?.url ? previewMediaKind(preview.content_type) : null
  if (!kind) return <PosterFrame note={note} version={version} />
  if (kind === 'image') {
    return <img className="frame-media frame-media-image" src={preview.url} alt="Previa del encargo" onError={onMediaError} />
  }
  if (kind === 'audio') {
    return (
      <div className="poster" role="img" aria-label="Pieza de audio anterior">
        <span className="poster-light" aria-hidden="true" />
        <p className="poster-title">Audio anterior</p>
        <span className="poster-meta">Se puede leer, sin reproducción</span>
      </div>
    )
  }
  return <video className="frame-media" src={preview.url} playsInline controls onError={onMediaError} />
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
  const panelRef = useRef(null)
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const openerNode = opener.current
    document.body.classList.add('sheet-open')
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const node = panelRef.current
      if (!node) return
      const items = [...node.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((item) => !item.disabled && item.tabIndex !== -1)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.classList.remove('sheet-open')
      window.removeEventListener('keydown', onKey)
      if (openerNode instanceof HTMLElement && document.contains(openerNode)) openerNode.focus()
    }
  }, [onClose])
  return (
    <div className="sheet-layer">
      <button type="button" className="sheet-scrim" aria-label="Cerrar" tabIndex={-1} onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={panelRef}>
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
  const [kind, setKind] = useState(() => readStudioDraft()?.kind ?? 'from_scratch')
  const [note, setNote] = useState(() => readStudioDraft()?.note ?? '')
  const [files, setFiles] = useState([])
  const [format, setFormat] = useState(() => readStudioDraft()?.format ?? '')
  const [targets, setTargets] = useState(() => readStudioDraft()?.targets ?? [])
  const [encargo, setEncargo] = useState(null)
  const [encargos, setEncargos] = useState(null)
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
  const [arrive, setArrive] = useState(null)
  const [encargosError, setEncargosError] = useState('')
  const [activityError, setActivityError] = useState('')
  const [activityNonce, setActivityNonce] = useState(0)
  const [openingId, setOpeningId] = useState('')
  const installed = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const account = me?.accounts.find((item) => item.id === accountId) ?? null
  const encargoIdRef = useRef(null)
  const meRef = useRef(null)
  const screenRef = useRef(screen)
  const listRequest = useRef(0)
  const fileInputRef = useRef(null)
  const uploadAbortRef = useRef(null)
  const preparingLive = screen === 'preparing' && !uploading && encargo?.status !== 'failed' && encargo?.status !== 'draft'
  const beat = useBeat(
    encargo?.status === 'claimed' || encargo?.status === 'preparing' ? PREP_BEATS : QUEUE_BEATS,
    preparingLive,
  )

  const syncRoute = useCallback((next, id, historyMode = 'push') => {
    const path = pathFor(next, id)
    if (window.location.pathname === path) return
    const state = { screen: next }
    if (historyMode === 'replace') window.history.replaceState(state, '', path)
    else if (historyMode !== 'none') window.history.pushState(state, '', path)
  }, [])

  const go = useCallback((next, to = 'forward', historyMode = 'push') => {
    setDirection(to)
    setError('')
    if (next === 'encargos') {
      setEncargos(null)
      setEncargosError('')
    }
    if (next !== 'preview') setArrive(null)
    setScreen(next)
    screenRef.current = next
    window.scrollTo?.({ top: 0 })
    syncRoute(next, encargoIdRef.current, historyMode)
  }, [syncRoute])

  const notify = useCallback((message, tone = 'ok') => {
    setToast({ message, tone, id: Date.now() })
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (screen !== 'studio') return undefined
    writeSession(DRAFT_KEY, JSON.stringify({ kind, note, format, targets }))
    return undefined
  }, [screen, kind, note, format, targets])

  useEffect(() => {
    if (arrive !== 'ready' || screen !== 'preview') return undefined
    const timer = window.setTimeout(() => setArrive(null), motionOk() ? 1400 : 0)
    return () => window.clearTimeout(timer)
  }, [arrive, screen])

  useEffect(() => {
    const heading = document.querySelector('.phone .view h1')
    if (!(heading instanceof HTMLElement)) return undefined
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
    return undefined
  }, [screen])

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
    if (accounts.length > 0 && accounts.every((item) => Number.isInteger(item.streak_days))) {
      setStreaks((current) => ({
        ...current,
        ...Object.fromEntries(accounts.map((item) => [item.id, item.streak_days])),
      }))
      return
    }
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

  const loadEncargos = useCallback(async () => {
    const requestId = ++listRequest.current
    const response = await api.listEncargos()
    if (requestId !== listRequest.current) return
    if (response.ok) {
      setEncargos(response.data.encargos)
      setEncargosError('')
    } else {
      setEncargos([])
      setEncargosError(response.error.message)
    }
  }, [api])

  const applyEncargo = useCallback(async (data, historyMode = 'push') => {
    encargoIdRef.current = data.id
    setArrive(null)
    setEncargo(data)
    if (data.account_id) setAccountId(data.account_id)
    setApproved(data.status === 'approved' || data.status === 'scheduled')
    setPosterOnly(false)
    setPreview(null)
    if (data.status === 'scheduled') {
      setResult(data)
      const at = Date.parse(data.publish_at ?? '')
      setScheduleMode(Number.isFinite(at) && at > Date.now() + 60_000 ? 'at' : 'now')
    } else {
      setResult(null)
    }
    setChangeOpen(false)
    setUploading(false)
    if ((data.status === 'ready' || data.status === 'approved') && data.result_sha256) {
      const nextPreview = previewFromEncargo(data)
      if (nextPreview) setPreview(nextPreview)
      else setPosterOnly(true)
    }
    const next = screenForStatus(data.status)
    setDirection(historyMode === 'none' ? 'back' : 'forward')
    setError('')
    setScreen(next)
    window.scrollTo?.({ top: 0 })
    syncRoute(next, data.id, historyMode)
  }, [syncRoute])

  const enter = useCallback(async (response) => {
    if (!response.ok) {
      setError(response.error.message)
      setScreen('offline')
      return
    }
    adoptMe(response.data)
    if (response.data.needs_guide) {
      setScreen('welcome')
      syncRoute('welcome', null, 'replace')
      return
    }
    const route = readRoute()
    if (route.name === 'encargos') {
      setEncargos(null)
      setScreen('encargos')
      return
    }
    if (route.name === 'encargo') {
      const loaded = await api.getEncargo(route.id)
      if (!loaded.ok) {
        setError(loaded.error.message)
        setScreen('encargos')
        syncRoute('encargos', null, 'replace')
        return
      }
      await applyEncargo(loaded.data, 'replace')
      return
    }
    setScreen('studio')
  }, [adoptMe, api, applyEncargo, syncRoute])

  const loadMe = useCallback(() => api.getMe().then(enter), [api, enter])

  useEffect(() => {
    api.getMe().then(enter)
  }, [api, enter])

  useEffect(() => {
    if (screen !== 'history' || !accountId) return undefined
    let stopped = false
    api.getActivity(accountId).then((response) => {
      if (stopped) return
      if (response.ok) {
        setActivity(response.data.items)
        setActivityError('')
      } else {
        setActivity([])
        setActivityError(response.error.message)
      }
    })
    return () => {
      stopped = true
    }
  }, [api, screen, accountId, activityNonce])

  useEffect(() => {
    encargoIdRef.current = encargo?.id ?? null
    meRef.current = me
    screenRef.current = screen
  }, [encargo?.id, me, screen])

  useEffect(() => {
    if (screen !== 'encargos') return undefined
    let stopped = false
    const requestId = ++listRequest.current
    api.listEncargos().then((response) => {
      if (stopped || requestId !== listRequest.current) return
      if (response.ok) {
        setEncargos(response.data.encargos)
        setEncargosError('')
      } else {
        setEncargos([])
        setEncargosError(response.error.message)
      }
    })
    return () => {
      stopped = true
    }
  }, [api, screen])

  useEffect(() => {
    if (!encargo?.id || !TRACKED_SCREENS.has(screen)) return
    syncRoute(screen, encargo.id, 'push')
  }, [encargo?.id, screen, syncRoute])

  useEffect(() => {
    const onPop = () => {
      const route = readRoute()
      setDirection('back')
      setError('')
      setArrive(null)
      if (route.name === 'encargos') {
        screenRef.current = 'encargos'
        setEncargos(null)
        setEncargosError('')
        setScreen('encargos')
        return
      }
      if (route.name === 'home') {
        const profile = meRef.current
        const next = !profile ? 'loading' : profile.needs_guide ? 'welcome' : 'studio'
        screenRef.current = next
        setScreen(next)
        return
      }
      api.getEncargo(route.id).then((response) => {
        if (readRoute().id !== route.id) return
        if (!response.ok) {
          setError(response.error.message)
          setScreen('encargos')
          return
        }
        applyEncargo(response.data, 'none')
      })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [api, applyEncargo])

  const openTab = (tab) => {
    if (tab === screen) return
    const order = TABS.map((item) => item.id)
    if (tab === 'history') {
      setActivity(null)
      setActivityError('')
    }
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
  }

  const fail = (message, back = 'studio') => {
    setUploading(false)
    if (screenRef.current !== 'preparing' && screenRef.current !== back) {
      notify(message, 'error')
      return
    }
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
    encargoIdRef.current = null
    setEncargo(null)
    go('preparing')
    const created = await api.createEncargo({
      account_id: account.id,
      kind,
      note,
      format,
      targets: targets.map((id) => {
        const [platform, target] = id.split(':')
        return { platform, target }
      }),
    })
    if (!created.ok) {
      fail(created.error.message)
      return
    }
    writeSession(DRAFT_KEY, null)
    let activeEncargo = created.data
    setEncargo(activeEncargo)
    if (screenRef.current === 'encargos') loadEncargos()
    if (kind === 'edit') {
      const abort = new AbortController()
      uploadAbortRef.current = abort
      try {
        const totalParts = files.reduce((sum, file) => sum + Math.max(1, Math.ceil(file.size / PART_BYTES)), 0)
        let sentParts = 0
        for (const [fileIndex, source] of files.entries()) {
          if (abort.signal.aborted) return
          const interruptedId = fileIndex === 0 ? window.localStorage.getItem(UPLOAD_KEY) : null
          let hashed
          try {
            hashed = await hashFile(source, { partSize: PART_BYTES, signal: abort.signal })
          } catch (error) {
            if (abort.signal.aborted || error?.name === 'AbortError') return
            fail('No se pudo leer el archivo.')
            return
          }
          const sourceSha256 = hashed.sha256
          const uploadBody = {
            encargo_id: activeEncargo.id,
            size_bytes: source.size,
            mime: source.type || 'application/octet-stream',
            sha256: sourceSha256,
          }
          let upload = await api.createUpload({ ...uploadBody, resume_id: interruptedId })
          if (abort.signal.aborted) return
          if (!upload.ok && interruptedId) {
            window.localStorage.removeItem(UPLOAD_KEY)
            upload = await api.createUpload(uploadBody)
          }
          if (abort.signal.aborted) return
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
          if (abort.signal.aborted) return
          const uploadSessionId = upload.data.upload_id
          window.localStorage.setItem(UPLOAD_KEY, uploadSessionId)
          const partSize = upload.data.part_size || PART_BYTES
          let uploaded
          try {
            uploaded = await uploadParts({
              source,
              partSize,
              partHashes: partSize === PART_BYTES ? hashed.partHashes : null,
              uploadedParts: new Set(upload.data.uploaded_parts ?? []),
              signal: abort.signal,
              uploadPart: (number, blob, sha256, options) => api.uploadPart(uploadSessionId, number, blob, sha256, options),
              onPartDone: () => {
                sentParts += 1
                setUploadProgress(Math.round((sentParts / totalParts) * 100))
              },
            })
          } catch (error) {
            if (abort.signal.aborted || error?.name === 'AbortError') return
            fail('No se pudo subir el archivo.')
            return
          }
          if (abort.signal.aborted) return
          if (!uploaded.ok) {
            fail(uploaded.error.message)
            return
          }
          const completed = await api.completeUpload(uploadSessionId, { sha256: sourceSha256 })
          if (abort.signal.aborted) return
          if (!completed.ok) {
            fail(completed.error.message)
            return
          }
          window.localStorage.removeItem(UPLOAD_KEY)
        }
        setUploading(false)
        if (screenRef.current === 'encargos') loadEncargos()
      } finally {
        if (uploadAbortRef.current === abort) uploadAbortRef.current = null
      }
    }
  }

  const encargoId = encargo?.id

  useEffect(() => {
    if (screen !== 'preparing' || !encargoId || uploading) return undefined
    let stopped = false
    let inflight = false
    const poll = async () => {
      if (document.visibilityState !== 'visible' || stopped || inflight) return
      inflight = true
      try {
        const response = await api.getEncargo(encargoId)
        if (!response.ok || stopped || response.notModified) return
        setEncargo(response.data)
        if (response.data.status === 'cancelled') {
          go('cancelled', 'back')
          return
        }
        if (response.data.status === 'scheduled') {
          setResult(response.data)
          const at = Date.parse(response.data.publish_at ?? '')
          setScheduleMode(Number.isFinite(at) && at > Date.now() + 60_000 ? 'at' : 'now')
          go('done')
          return
        }
        if (response.data.status === 'failed') return
        if (response.data.status === 'ready' || response.data.status === 'approved') {
          const nextPreview = previewFromEncargo(response.data)
          if (stopped) return
          if (nextPreview) setPreview(nextPreview)
          else setPosterOnly(true)
          setArrive('ready')
          celebrate()
          go('preview')
        }
      } finally {
        inflight = false
      }
    }
    poll()
    const timer = window.setInterval(poll, 15_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
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
    if (Number.isInteger(scheduled.data.streak_days)) {
      setStreaks((current) => ({ ...current, [account.id]: scheduled.data.streak_days }))
    } else {
      const nextStreak = await api.getStreak(account.id)
      if (nextStreak.ok) setStreaks((current) => ({ ...current, [account.id]: nextStreak.data.days }))
    }
    setBusy('')
    go('done')
  }

  const cancelActiveEncargo = async () => {
    if (!encargo?.id || busy) return
    uploadAbortRef.current?.abort()
    tap()
    const cancelled = await run('cancel', () => api.cancelEncargo(encargo.id))
    if (!cancelled) {
      setUploading(false)
      return
    }
    setEncargo({ ...encargo, ...cancelled, id: cancelled.id ?? encargo.id })
    setApproved(false)
    setPreview(null)
    setPosterOnly(false)
    setChangeOpen(false)
    setChangeNote('')
    setUploading(false)
    window.localStorage.removeItem(UPLOAD_KEY)
    notify('Encargo cancelado')
    go('cancelled', 'back')
  }

  const openListed = async (item) => {
    if (openingId) return
    tap()
    setOpeningId(item.id)
    await applyEncargo(item, 'forward')
    setOpeningId('')
    api.getEncargo(item.id).then((response) => {
      if (!response.ok || response.notModified || encargoIdRef.current !== item.id) return
      setEncargo((current) => {
        if (!encargoNeedsRefresh(current, response.data)) return current
        return { ...response.data, id: response.data.id ?? item.id }
      })
      if ((response.data.status === 'ready' || response.data.status === 'approved') && response.data.result_sha256) {
        const nextPreview = previewFromEncargo(response.data)
        if (nextPreview) setPreview((current) => (current?.url === nextPreview.url ? current : nextPreview))
      }
    })
  }

  const cancelListed = async (item) => {
    tap()
    const cancelled = await run('cancel', () => api.cancelEncargo(item.id))
    if (!cancelled) return
    setEncargos((current) => current?.map((row) => (
      row.id === item.id ? { ...row, ...cancelled, id: row.id, status: cancelled.status ?? 'cancelled' } : row
    )))
    notify('Encargo cancelado')
  }

  const requestChanges = async (event) => {
    event.preventDefault()
    tap()
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

  const copyText = async (value, okMessage) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
      else {
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.left = '-9999px'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        if (!copied) throw new Error('copy')
      }
      tap()
      notify(okMessage)
    } catch {
      notify('No he podido copiarlo.', 'error')
    }
  }

  const startOver = (target = 'studio') => {
    writeSession(DRAFT_KEY, null)
    setKind('from_scratch')
    setNote('')
    setFiles([])
    setFormat('')
    setTargets([])
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

  const closeChange = useCallback(() => setChangeOpen(false), [])
  const ready = Boolean(account && !account.pending && format && targets.length && (kind === 'edit' ? files.length : note.trim()))
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
      <Button variant="outline" className="entry" onClick={() => openTab('encargos')}>
        <List aria-hidden="true" data-icon="inline-start" />
        Mis encargos
        <ArrowRight aria-hidden="true" data-icon="inline-end" />
      </Button>
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
                <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" multiple onChange={(event) => {
                  const chosen = Array.from(event.target.files || [])
                  event.target.value = ''
                  if (chosen.some((file) => file.size > MAX_FILE_BYTES)) {
                    setError('Ese archivo supera los 150 MB. Elige uno más pequeño.')
                    setFiles([])
                    return
                  }
                  setError('')
                  setFiles(chosen)
                  tap()
                }} />
              </label>
              {files.length > 0 && (
                <div className="thumbs">
                  {files.map((file) => (
                    <div className="thumb-wrap" key={`${file.name}-${file.size}-${file.lastModified}`}>
                      <FilePreview file={file} />
                      <button type="button" className="thumb-remove" aria-label={`Quitar ${file.name}`} onClick={() => {
                        tap()
                        setFiles((current) => current.filter((item) => item !== file))
                        if (fileInputRef.current) fileInputRef.current.value = ''
                      }}><X aria-hidden="true" /></button>
                    </div>
                  ))}
                </div>
              )}
              {window.localStorage.getItem(UPLOAD_KEY) && <p className="fine">Hay una subida a medias. Elige exactamente los mismos archivos para continuar.</p>}
              <Field>
                <FieldLabel htmlFor="note">Indicaciones</FieldLabel>
                <Textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="Opcional. Por ejemplo: quita solo el principio" />
              </Field>
            </div>
          )}
        </div>
      </Section>
      <Section label="Formato y destino" id="label-format">
        <FormatPicker format={format} targets={targets} onFormat={(next) => { setFormat(next); setTargets([]) }} onTargets={setTargets} />
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
    const failed = status === 'failed'
    const draft = status === 'draft'
    const stageIndex = stageIndexFor(status)
    const eyebrow = uploading
      ? `Subiendo · ${uploadProgress}%`
      : encargo?.version > 1
        ? `Toma ${encargo.version}`
        : statusLabel(status)
    const hint = uploading
      ? 'No cierres la app hasta que termine la subida.'
      : failed
        ? 'No he podido terminarlo. Puedes cerrar la app; el estado sigue aquí cuando vuelvas.'
        : draft
          ? 'La subida no terminó. Vuelve al inicio y elige los mismos archivos para continuarla.'
          : 'Puedes cerrar la app; aquí verás el estado de tu encargo cuando vuelvas.'
    view = (
      <>
        <TopBar onBack={() => go('encargos', 'back')} backLabel="Mis encargos" />
        <Heading eyebrow={eyebrow}>{failed ? <>No ha <em>salido.</em></> : <>Revelando <em>tu toma.</em></>}</Heading>
        {!failed && (
          <div className="darkroom" data-live="true" aria-hidden="true">
            <span className="darkroom-frame"><Skeleton className="h-full w-full rounded-[inherit]" /></span>
            <span className="darkroom-sweep" />
            <span className="darkroom-rec"><span className="rec-dot" />REC</span>
          </div>
        )}
        {failed && <Badge variant="outline" className="status-pill"><XCircle aria-hidden="true" />Fallido</Badge>}
        {uploading && <Progress value={uploadProgress} aria-label="Subida de archivos" />}
        {preparingLive && (
          <div
            className="stage-meter"
            role="progressbar"
            aria-label="Preparando tu encargo"
            aria-valuemin={1}
            aria-valuemax={STAGES.length}
            aria-valuenow={stageIndex + 1}
            aria-valuetext={STAGES[stageIndex]?.label ?? statusLabel(status)}
          >
            {STAGES.map((stage, index) => (
              <i key={stage.id} aria-hidden="true" data-state={index < stageIndex ? 'done' : index === stageIndex ? 'now' : 'todo'} />
            ))}
          </div>
        )}
        {!failed && (
          <ol className="stages">
            {STAGES.map((stage, index) => {
              const state = uploading || draft ? 'todo' : index < stageIndex ? 'done' : index === stageIndex ? 'now' : 'todo'
              return (
                <li key={stage.id} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                  <span className="stage-dot" aria-hidden="true">{state === 'done' ? <Check /> : null}</span>{stage.label}
                </li>
              )
            })}
          </ol>
        )}
        {preparingLive && <p className="beat" aria-hidden="true" key={beat}>{beat}</p>}
        {preparingLive && <p className="sr-only" aria-live="polite">{statusLabel(status)}</p>}
        {encargo && <p className="fine"><FitSummary item={encargo} /></p>}
        <p className="fine">{hint}</p>
        <ErrorLine>{error}</ErrorLine>
      </>
    )
    cta = (
      <div className="cta-stack">
        <Button size="lg" variant="outline" className="cta-secondary" onClick={() => go('studio', 'back')}>Inicio</Button>
        <CancelEncargoAction encargo={encargo} busy={busy} onConfirm={cancelActiveEncargo} />
      </div>
    )
  }

  if (screen === 'preview') {
    const synthetic = preview?.synthetic || preview?.contains_synthetic_media || encargo?.synthetic
    view = (
      <>
        <TopBar onBack={() => go('encargos', 'back')} backLabel="Mis encargos" />
        <Heading eyebrow={`Versión ${encargo?.version ?? 1}`}>Mira <em>lo que he preparado</em></Heading>
        <SwipeDeck disabled={Boolean(busy)} onRight={approveAndSchedule} onLeft={() => setChangeOpen(true)}>
          <div className="frame">
            <div className="frame-crop">
              <FramePreview
                preview={preview}
                posterOnly={posterOnly}
                onMediaError={() => setPosterOnly(true)}
                note={encargo?.note ?? note}
                version={encargo?.version}
              />
            </div>
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
          <Sheet title="¿Qué cambio?" onClose={closeChange}>
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
      <div className="cta-stack">
        <div className="cta-pair">
          <Button size="lg" className="cta" onClick={approveAndSchedule} disabled={Boolean(busy)}>
            <CtaLabel icon={Check} busy={busy === 'approve'}>{scheduleMode === 'at' ? 'Aprobar y programar' : 'Aprobar y publicar'}</CtaLabel>
          </Button>
          <Button size="lg" variant="outline" className="cta-secondary" onClick={() => setChangeOpen(true)} disabled={Boolean(busy)}>Pedir un cambio</Button>
        </div>
        <CancelEncargoAction encargo={encargo} busy={busy} onConfirm={cancelActiveEncargo} />
      </div>
    )
  }

  if (screen === 'cancelled') {
    view = (
      <>
        <TopBar onBack={() => go('encargos', 'back')} backLabel="Mis encargos" />
        <Heading eyebrow="Estado: cancelado">Encargo <em>cancelado</em></Heading>
        <Badge variant="secondary" className="status-pill"><XCircle aria-hidden="true" />Cancelado</Badge>
        <p className="lead">Ya no se preparará ni se publicará en la simulación.</p>
        {encargo && (
          <dl className="ticket">
            <TicketFit item={encargo} />
            <div><dt>Estado</dt><dd>cancelado</dd></div>
          </dl>
        )}
      </>
    )
    cta = (
      <div className="cta-pair">
        <Button size="lg" className="cta" onClick={() => startOver('studio')}><CtaLabel icon={Plus}>Crear otro</CtaLabel></Button>
        <Button size="lg" variant="outline" className="cta-secondary" onClick={() => startOver('history')}>Ver historial</Button>
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
        <TopBar onBack={() => go('encargos', 'back')} backLabel="Mis encargos" />
        <div className="confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <i key={index} />)}</div>
        <div className="stamp" aria-hidden="true"><Check /></div>
        <Heading eyebrow="Simulación terminada">¡Corten! <em>{later ? 'Queda programado.' : 'Está publicado.'}</em></Heading>
        <dl className="ticket">
          <TicketFit item={result?.targets ? result : encargo} />
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

  if (screen === 'encargos') view = (
    <>
      <TopBar />
      <Heading eyebrow="Tu camerino">Mis <em>encargos</em></Heading>
      {encargos === null ? <ListSkeleton /> : encargosError ? (
        <LoadError title="No he podido cargar los encargos" detail={encargosError} onRetry={() => { setEncargos(null); setEncargosError(''); loadEncargos() }} />
      ) : encargos.length === 0 ? (
        <Empty className="min-h-0 flex-none items-start rounded-2xl border border-dashed border-input p-6 text-left">
          <EmptyHeader className="items-start text-left">
            <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
            <EmptyTitle>Todavía no tienes encargos</EmptyTitle>
            <EmptyDescription>Cuando prepares una idea, el estado queda aquí aunque cierres la app.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="items-start">
            <Button variant="outline" onClick={() => openTab('studio')}>Preparar el primero</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="feed">
          {encargos.map((item) => {
            const tone = item.status === 'cancelled' || item.status === 'failed' ? 'status-pill' : undefined
            const variant = item.status === 'ready' ? 'default' : 'secondary'
            return (
              <li key={item.id} className="encargo-row">
                <button type="button" className="encargo-open" aria-busy={openingId === item.id || undefined} disabled={openingId === item.id} onClick={() => openListed(item)}>
                  <span>
                    <strong className="encargo-title">{encargoTitle(item)}</strong>
                    <FitSummary item={item} />
                    <span>
                      {(me?.accounts.length ?? 0) > 1 && `${item.account_name ?? account?.name ?? 'Cuenta'} · `}
                      Actualizado {formatWhen(item.updated_at ?? item.created_at, timeZone)}
                    </span>
                  </span>
                  {openingId === item.id && <LoaderCircle className="spin" aria-hidden="true" />}
                  <Badge variant={variant} className={tone}>{statusLabel(item.status)}</Badge>
                </button>
                <CancelEncargoAction encargo={item} busy={busy} onConfirm={() => cancelListed(item)} />
              </li>
            )
          })}
        </ul>
      )}
      <ErrorLine>{error}</ErrorLine>
    </>
  )

  if (screen === 'history') view = (
    <>
      <TopBar />
      <Heading eyebrow={account?.name}>Lo que <em>ha salido</em></Heading>
      {activity === null ? <ListSkeleton /> : activityError ? (
        <LoadError title="No he podido cargar el historial" detail={activityError} onRetry={() => { setActivity(null); setActivityError(''); setActivityNonce((current) => current + 1) }} />
      ) : activity.length === 0 ? (
        <Empty className="min-h-0 flex-none items-start rounded-2xl border border-dashed border-input p-6 text-left">
          <EmptyHeader className="items-start text-left">
            <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
            <EmptyTitle>Todavía no hay simulaciones</EmptyTitle>
            <EmptyDescription>Cuando apruebes una toma, la referencia queda aquí.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="items-start">
            <Button variant="outline" onClick={() => openTab('studio')}>Preparar la primera</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="feed">
          {activity.map((item) => (
            <li key={item.id}>
              <span className={`platform-dot platform-${String(item.platform).split(',')[0].trim().toLowerCase()}`} aria-hidden="true" />
              <div>
                <strong>{platformLabel(item.platform)}</strong>
                <span>{formatWhen(item.published_at ?? item.created_at, timeZone)}</span>
              </div>
              <button type="button" className="mock-copy" aria-label={`Copiar ${item.mock_id}`} onClick={() => copyText(item.mock_id, 'Identificador copiado')}>{item.mock_id}</button>
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
              <button type="button" className="account-open" disabled={item.pending} aria-pressed={item.id === accountId} onClick={() => { tap(); setAccountId(item.id) }}>
                <span className="avatar" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{item.name}</strong><span>{item.pending ? 'Creando…' : `Racha de ${days(streaks[item.id] ?? 0)}`}</span></span>
                {item.id === accountId && <Check aria-hidden="true" />}
              </button>
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
        <div className="view" key={screen} data-screen={screen} data-dir={direction} data-arrive={arrive && screen === 'preview' ? arrive : undefined}>{view}</div>
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
