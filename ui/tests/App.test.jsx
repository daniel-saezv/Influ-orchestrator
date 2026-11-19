import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../src/App.jsx'
import fakeApi, { configureFakeApi, getFakeApiState, resetFakeApi } from '../src/api/fakeApi.js'

describe('mobile creation flow', () => {
  beforeEach(() => {
    resetFakeApi()
    configureFakeApi({ transitionReads: 0.5 })
    localStorage.clear()
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
    expect(screen.getByRole('button', { name: 'YouTube' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Instagram' }))
    await user.click(screen.getByRole('button', { name: 'TikTok' }))
    await user.click(screen.getByRole('button', { name: 'Preparar' }))

    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    expect(screen.getByText('Hecho con ayuda de IA')).toBeInTheDocument()
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
    expect(screen.getByText('YouTube, Instagram, TikTok')).toBeInTheDocument()
    expect(getFakeApiState().encargos[0]).toMatchObject({ status: 'scheduled', version: 2 })
    await user.click(screen.getByRole('button', { name: 'Ver historial' }))
    expect(await screen.findAllByText(/MOCK-/)).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Historial' })).toHaveAttribute('aria-current', 'page')
  })

  it('cancels an encargo from the preview step after confirmation', async () => {
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    expect(await screen.findByRole('heading', { name: 'Tu camerino está listo.' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Nombre'), 'Alex')
    await user.click(screen.getByRole('button', { name: 'Empezar' }))
    await user.type(screen.getByLabelText('Tu idea'), 'Cancelar antes de publicar')
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
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    expect(screen.getByText('Puedes cerrar la app; aquí verás el estado de tu encargo cuando vuelvas.')).toBeInTheDocument()
    expect(screen.queryByText(/segundo plano/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inicio' })).toBeInTheDocument()
    const encargoId = getFakeApiState().encargos.at(-1).id
    await waitFor(() => expect(window.location.pathname).toBe(`/encargos/${encargoId}`))

    await user.click(screen.getByRole('button', { name: 'Mis encargos' }))
    expect(await screen.findByRole('heading', { name: 'Mis encargos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Una toma para mañana/ })).toHaveTextContent('En cola')
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

  it('does not poll an encargo while the page is hidden', async () => {
    resetFakeApi({ onboarded: true })
    configureFakeApi({ transitionReads: 100 })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    await user.type(await screen.findByLabelText('Tu idea'), 'Sigo en segundo plano')
    await user.click(screen.getByRole('button', { name: 'Preparar' }))
    expect(await screen.findByRole('heading', { name: 'Revelando tu toma.' })).toBeInTheDocument()
    expect(getFakeApiState().encargos.at(-1).reads).toBe(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(getFakeApiState().encargos.at(-1).reads).toBe(1))
  })
})
