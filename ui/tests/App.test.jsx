import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.jsx'
import fakeApi, { configureFakeApi, getFakeApiState, resetFakeApi } from '../src/api/fakeApi.js'
import { resetStudioFiles } from '../src/lib/studio-files.js'

async function chooseFormat(user, label, targets) {
  await user.click(screen.getByRole('radio', { name: new RegExp(label) }))
  for (const target of targets) await user.click(screen.getByRole('button', { name: target }))
}

describe('mobile creation flow', () => {
  beforeEach(() => {
    resetFakeApi()
    configureFakeApi({ transitionReads: 0.5 })
    localStorage.clear()
    sessionStorage.clear()
    resetStudioFiles()
    delete document.documentElement.dataset.theme
    window.history.replaceState({}, '', '/')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('guides a first-time user from the idea to three MOCK platforms and activity', async () => {
    const user = userEvent.setup()
    render(<App api={fakeApi} />)

    expect(await screen.findByRole('heading', { name: 'Tu camerino está listo.' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Cómo funciona' }).querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('heading', { level: 1 }).closest('.view')).toHaveAttribute('data-dir', 'forward')
    await user.type(screen.getByLabelText('Nombre'), 'Alex')
    await user.click(screen.getByRole('button', { name: 'Empezar' }))

    expect(await screen.findByRole('heading', { name: '¿Qué grabamos hoy?' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Alex/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Preparar' })).toBeDisabled()
    await user.type(screen.getByLabelText('Tu idea'), 'Una presentación de mi nuevo proyecto')
    expect(screen.queryByRole('button', { name: 'YouTube Short' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preparar' })).toBeDisabled()
    const fit = screen.getByRole('region', { name: 'Formato y destino' })
    expect(within(fit).getByText('Elige un formato y aquí verás dónde sale.')).toBeInTheDocument()
    await chooseFormat(user, 'Foto', [])
    expect(within(fit).getByText('No publica fotos')).toBeInTheDocument()
    expect(within(fit).getByRole('button', { name: 'Instagram Feed' })).toBeInTheDocument()
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short', 'Instagram Reel', 'TikTok Vídeo'])
    expect(within(fit).queryByText('No publica fotos')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Instagram Story' }))
    expect(screen.getByRole('button', { name: 'Instagram Reel' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Instagram Reel' }))
    await user.click(screen.getByRole('button', { name: 'Preparar' }))

    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    const aiNote = screen.getByText('Hecho con ayuda de IA')
    expect(aiNote.closest('.frame')).toBeTruthy()
    expect(aiNote.closest('.frame-crop')).toBeNull()
    expect(screen.getByText('Versión 1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pedir un cambio' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    expect(getFakeApiState().encargos[0].status).toBe('ready')
    await user.click(screen.getByRole('button', { name: 'Pedir un cambio' }))
    const sheet = screen.getByRole('dialog', { name: '¿Qué cambio?' })
    await user.type(within(sheet).getByLabelText('Cambio'), 'Más corto')
    await user.click(within(sheet).getByRole('button', { name: 'Volver a preparar' }))
    expect(await screen.findByText('Versión 2')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Aprobar y publicar' }))
    expect(await screen.findByRole('heading', { name: '¡Corten! Está publicado.' })).toBeInTheDocument()
    expect(screen.getByText('YouTube Short, TikTok Vídeo, Instagram Reel')).toBeInTheDocument()
    expect(getFakeApiState().encargos[0]).toMatchObject({ status: 'scheduled', version: 2 })
    await user.click(screen.getByRole('button', { name: 'Ver historial' }))
    expect(await screen.findAllByText(/MOCK-/)).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Historial' })).toHaveAttribute('aria-current', 'page')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await user.click(screen.getAllByRole('button', { name: /^Copiar MOCK-/ })[0])
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^MOCK-/))
    expect(await screen.findByText('Identificador copiado')).toBeInTheDocument()
  })

  it('cancels an encargo from the preview step after confirmation', async () => {
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    expect(await screen.findByRole('heading', { name: 'Tu camerino está listo.' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Nombre'), 'Alex')
    await user.click(screen.getByRole('button', { name: 'Empezar' }))
    await user.type(screen.getByLabelText('Tu idea'), 'Cancelar antes de publicar')
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancelar encargo' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sí, cancelar' }))
    expect(await screen.findByRole('heading', { name: 'Encargo cancelado' })).toBeInTheDocument()
    expect(getFakeApiState().encargos.at(-1).status).toBe('cancelled')
  })

  it('uploads a plain crop without an AI notice and schedules it for later', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 0.5 })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    await user.click(await screen.findByRole('radio', { name: 'Mis archivos' }))
    expect(screen.getByRole('button', { name: 'Preparar' })).toBeDisabled()

    const file = new File(['crop'], 'original.mp4', { type: 'video/mp4' })
    await user.upload(screen.getByLabelText(/Elegir vídeo, audio o fotos/), file)
    expect(screen.getByRole('button', { name: 'Quitar original.mp4' })).toBeInTheDocument()
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.type(screen.getByLabelText('Indicaciones'), 'Solo recorta el final')
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    expect(getFakeApiState().encargos[0].synthetic).toBe(false)
    expect(screen.queryByText('Hecho con ayuda de IA')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Elegir hora' }))
    expect(screen.getByRole('button', { name: 'Aprobar y programar' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Aprobar y programar' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Elige día y hora')
    await user.type(screen.getByLabelText('Día y hora'), '2026-11-20T09:30')
    await user.click(screen.getByRole('button', { name: 'Aprobar y programar' }))
    expect(await screen.findByRole('heading', { name: '¡Corten! Queda programado.' })).toBeInTheDocument()
    expect(getFakeApiState().encargos[0].publish_at).toBe(new Date('2026-11-20T09:30').toISOString())
  })

  it('creates an account optimistically and switches the theme', async () => {
    resetFakeApi({ onboarded: true })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    await user.click(await screen.findByRole('button', { name: 'Tú' }))
    await user.type(screen.getByLabelText('Nombre de la cuenta'), 'Segunda')
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }))
    expect(screen.getByText('Segunda')).toBeInTheDocument()
    expect(await screen.findByText('Cuenta «Segunda» lista')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Alex/ }))
    expect(screen.getByRole('button', { name: /^Alex/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /Segunda/ }))
    expect(screen.getByRole('button', { name: /Segunda/ })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('radio', { name: 'Oscuro' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('influ-theme')).toBe('dark')
    await user.click(screen.getByRole('radio', { name: 'Sistema' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('influ-theme')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Estudio' }))
    expect(screen.getByRole('radio', { name: /Segunda/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('lists encargos from the server and reopens the same one after a reload', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 100 })
    const user = userEvent.setup()
    const view = render(<App api={fakeApi} />)

    await user.click(await screen.findByRole('button', { name: 'Mis encargos' }))
    expect(await screen.findByText('Todavía no tienes encargos')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Encargos' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('button', { name: 'Preparar el primero' }))

    await user.type(screen.getByLabelText('Tu idea'), 'Una toma para mañana')
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    const meter = screen.getByRole('progressbar', { name: 'Preparando tu encargo' })
    expect(meter).toHaveAttribute('aria-valuenow', '1')
    expect(meter).toHaveAttribute('aria-valuemax', '3')
    expect(meter).toHaveAttribute('aria-valuetext', 'En cola')
    expect(screen.getByText('En cola, en silencio…')).toBeInTheDocument()
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('En cola')
    expect(screen.queryByText('30%')).not.toBeInTheDocument()
    expect(screen.getByText('Vídeo corto · YouTube Short')).toBeInTheDocument()
    expect(screen.getByText('Puedes cerrar la app; aquí verás el estado de tu encargo cuando vuelvas.')).toBeInTheDocument()
    expect(screen.queryByText(/segundo plano/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inicio' })).toBeInTheDocument()
    const encargoId = getFakeApiState().encargos.at(-1).id
    await waitFor(() => expect(window.location.pathname).toBe(`/encargos/${encargoId}`))

    await user.click(screen.getByRole('button', { name: 'Mis encargos' }))
    expect(await screen.findByRole('heading', { name: 'Mis encargos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Una toma para mañana/ })).toHaveTextContent('En cola')
    expect(screen.getByRole('button', { name: /Una toma para mañana/ })).toHaveTextContent('Vídeo corto · YouTube Short')
    expect(screen.getByText(/Actualizado/)).toBeInTheDocument()

    view.unmount()
    window.history.replaceState({}, '', `/encargos/${encargoId}`)
    render(<App api={fakeApi} />)
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/encargos/${encargoId}`)

    await user.click(screen.getByRole('button', { name: 'Mis encargos' }))
    await user.click(await screen.findByRole('button', { name: 'Cancelar encargo' }))
    await user.click(screen.getByRole('button', { name: 'Sí, cancelar' }))
    expect(await screen.findByText('Cancelado')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar encargo' })).not.toBeInTheDocument()
    expect(getFakeApiState().encargos.at(-1).status).toBe('cancelled')
  })

  it('shows an image preview in the review frame when the deliverable is image/jpeg', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 0.5, previewMime: 'image/jpeg' })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)

    await user.type(await screen.findByLabelText('Tu idea'), 'Frame con una imagen vertical')
    await chooseFormat(user, 'Foto', ['Instagram Feed'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Previa del encargo' })).toHaveClass('frame-media-image')
    expect(screen.queryByRole('video')).not.toBeInTheDocument()
  })

  it('keeps an old audio deliverable readable without a player', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 0.5, previewMime: 'audio/mpeg' })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    await user.type(await screen.findByLabelText('Tu idea'), 'Una pista antigua')
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('img', { name: 'Pieza de audio anterior' })).toBeInTheDocument()
    expect(document.querySelector('audio')).toBeNull()
  })

  it('truncates a long encargo title without hiding cancel on narrow layouts', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 100 })
    const longNote = 'En un bar casual con un anuncio publicitario distinto que empuja el layout si no se recorta en móvil'
    const user = userEvent.setup()
    render(<App api={fakeApi} />)

    await user.click(await screen.findByRole('button', { name: 'Mis encargos' }))
    await user.click(screen.getByRole('button', { name: 'Preparar el primero' }))
    await user.type(screen.getByLabelText('Tu idea'), longNote)
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    await user.click(await screen.findByRole('button', { name: 'Mis encargos' }))

    const title = await screen.findByText(longNote)
    expect(title).toHaveClass('encargo-title')
    const row = title.closest('li')
    expect(row?.querySelector('.encargo-open')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Cancelar encargo' })).toBeInTheDocument()
  })

  it('does not poll an encargo while the page is hidden', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 100 })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    await user.type(await screen.findByLabelText('Tu idea'), 'Sigo en segundo plano')
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    expect(getFakeApiState().encargos.at(-1).reads).toBe(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(getFakeApiState().encargos.at(-1).reads).toBe(1))
  })

  it('restores the studio draft within the session', async () => {
    resetFakeApi({ onboarded: true })
    sessionStorage.setItem('influ-studio-draft', JSON.stringify({
      kind: 'from_scratch',
      note: 'Idea guardada',
      format: 'short_video',
      targets: ['youtube:short', 'tiktok:video'],
    }))
    const view = render(<App api={fakeApi} />)
    expect(await screen.findByLabelText('Tu idea')).toHaveValue('Idea guardada')
    expect(screen.getByRole('radio', { name: /Vídeo corto/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'YouTube Short' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'TikTok Vídeo' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Instagram Reel' })).toHaveAttribute('aria-pressed', 'false')
    view.unmount()

    sessionStorage.setItem('influ-studio-draft', JSON.stringify({
      kind: 'from_scratch',
      note: 'Idea antigua',
      platforms: ['YouTube', 'TikTok'],
    }))
    render(<App api={fakeApi} />)
    expect(await screen.findByLabelText('Tu idea')).toHaveValue('Idea antigua')
    expect(screen.queryByRole('button', { name: 'YouTube Short' })).not.toBeInTheDocument()
  })

  it('shows a load error instead of an empty encargos list', async () => {
    resetFakeApi({ onboarded: true })
    const user = userEvent.setup()
    const api = {
      ...fakeApi,
      listEncargos: async () => ({ ok: false, error: { message: 'No he podido leer los encargos.' } }),
    }
    render(<App api={api} />)
    await user.click(await screen.findByRole('button', { name: 'Mis encargos' }))
    expect(await screen.findByText('No he podido cargar los encargos')).toBeInTheDocument()
    expect(screen.getByText('No he podido leer los encargos.')).toBeInTheDocument()
    expect(screen.queryByText('Todavía no tienes encargos')).not.toBeInTheDocument()
  })

  it('keeps chosen files when leaving the form and lets you remove them', async () => {
    resetFakeApi({ onboarded: true })
    const user = userEvent.setup()
    const view = render(<App api={fakeApi} />)
    await user.click(await screen.findByRole('radio', { name: 'Mis archivos' }))
    const file = new File(['crop'], 'original.mp4', { type: 'video/mp4' })
    await user.upload(screen.getByLabelText(/Elegir vídeo, audio o fotos/), file)
    expect(screen.getByRole('button', { name: 'Quitar original.mp4' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Encargos' }))
    view.unmount()
    render(<App api={fakeApi} />)
    await user.click(await screen.findByRole('button', { name: 'Estudio' }))
    await user.click(await screen.findByRole('radio', { name: 'Mis archivos' }))
    expect(screen.getByRole('button', { name: 'Quitar original.mp4' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Quitar original.mp4' }))
    expect(screen.queryByRole('button', { name: 'Quitar original.mp4' })).not.toBeInTheDocument()
  })

  it('reuses a finished upload instead of sending that file again', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 100 })
    const user = userEvent.setup()
    const sizes = []
    let encargos = 0
    const api = {
      ...fakeApi,
      createEncargo: async (body) => {
        encargos += 1
        return fakeApi.createEncargo(body)
      },
      createUpload: async (body) => {
        sizes.push(body.size_bytes)
        if (body.size_bytes === 6 && sizes.filter((size) => size === 6).length === 1) {
          return { ok: false, status: 400, error: { code: 'UPLOAD', message: 'corte de subida' } }
        }
        return fakeApi.createUpload(body)
      },
    }
    render(<App api={api} />)
    await user.click(await screen.findByRole('radio', { name: 'Mis archivos' }))
    const first = new File(['aaaa'], 'toma.mp4', { type: 'video/mp4' })
    const second = new File(['bbbbbb'], 'extra.mp4', { type: 'video/mp4' })
    await user.upload(screen.getByLabelText(/Elegir vídeo, audio o fotos/), [first, second])
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: '¿Qué grabamos hoy?' })).toBeInTheDocument()
    expect(screen.getByText('corte de subida')).toBeInTheDocument()
    expect(screen.getByText('Subido')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    expect(encargos).toBe(1)
    expect(sizes.filter((size) => size === 4)).toEqual([4])
    expect(sizes.filter((size) => size === 6)).toEqual([6, 6])
  })

  it('retries a failed encargo from its detail', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 100 })
    const user = userEvent.setup()
    let retried = false
    const api = {
      ...fakeApi,
      getEncargo: async (id) => {
        const response = await fakeApi.getEncargo(id)
        if (response.ok && !retried) response.data = { ...response.data, status: 'failed' }
        return response
      },
      retryEncargo: async (id) => {
        retried = true
        return { ok: true, data: { id, status: 'queued', kind: 'from_scratch' } }
      },
    }
    render(<App api={api} />)
    await user.type(await screen.findByLabelText('Tu idea'), 'Otra toma')
    await chooseFormat(user, 'Vídeo corto', ['YouTube Short'])
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'No ha salido.' })).toBeInTheDocument()
    expect(screen.getByText('Los archivos siguen guardados. Reintentar no vuelve a subirlos.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    expect(retried).toBe(true)
  })
})
