import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../src/App.jsx'
import fakeApi, { configureFakeApi, getFakeApiState, resetFakeApi } from '../src/api/fakeApi.js'

describe('mobile creation flow', () => {
  beforeEach(() => {
    resetFakeApi()
    configureFakeApi({ transitionReads: 0.5 })
    localStorage.clear()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('guides a first-time user from the idea to three MOCK platforms and activity', async () => {
    const user = userEvent.setup()
    render(<App api={fakeApi} />)

    await user.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('heading', { name: 'Así de simple' })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'Así de simple' }).closest('.screen')).toHaveClass('view-enter')
    await user.click(screen.getByRole('button', { name: 'Empezar' }))
    await user.type(screen.getByLabelText('Nombre'), 'Alex')
    await user.click(screen.getByRole('button', { name: 'Listo' }))

    await user.click(await screen.findByRole('button', { name: /Alex/ }))
    await user.click(screen.getByRole('button', { name: /Crear desde cero/ }))
    await user.type(screen.getByLabelText('Tu idea'), 'Una presentación de mi nuevo proyecto')
    await user.click(screen.getByRole('button', { name: 'Prepararlo' }))
    expect(screen.getByRole('button', { name: 'YouTube' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Instagram' }))
    await user.click(screen.getByRole('button', { name: 'TikTok' }))
    await user.click(screen.getByRole('button', { name: 'Seguir' }))

    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    expect(screen.getByText('Hecho con ayuda de IA')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '¡Me gusta!' }))
    await user.click(screen.getByRole('button', { name: 'Listo' }))
    expect(await screen.findByRole('heading', { name: '¡Listo!' })).toBeInTheDocument()
    expect(screen.getByText(/youtube, instagram, tiktok/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Crear otro' }))
    await user.click(screen.getByRole('button', { name: 'Qué ha pasado' }))
    expect(await screen.findAllByText(/MOCK-/)).toHaveLength(3)
  })

  it('does not show an AI notice for a plain crop', async () => {
    resetFakeApi({ onboarded: true })
    const user = userEvent.setup()
    render(<App api={fakeApi} />)
    await user.click(screen.getByRole('button', { name: 'Entrar' }))
    await user.click(await screen.findByRole('button', { name: /Alex Studio/ }))
    await user.click(screen.getByRole('button', { name: /Editar mis vídeos/ }))

    const file = new File(['crop'], 'original.mp4', { type: 'video/mp4' })
    await user.upload(screen.getByLabelText('Elegir vídeo, audio o fotos'), file)
    await user.click(screen.getByRole('button', { name: 'Seguir' }))
    await user.type(screen.getByLabelText('Indicaciones'), 'Solo recorta el final')
    await user.click(screen.getByRole('button', { name: 'Prepararlo' }))
    await user.click(screen.getByRole('button', { name: 'Seguir' }))
    expect(await screen.findByRole('heading', { name: 'Mira lo que he preparado' })).toBeInTheDocument()
    expect(getFakeApiState().encargos[0].synthetic).toBe(false)
    expect(screen.queryByText('Hecho con ayuda de IA')).not.toBeInTheDocument()
  })
})
