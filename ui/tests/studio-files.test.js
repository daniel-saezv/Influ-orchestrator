import { beforeEach, describe, expect, it } from 'vitest'
import {
  currentStudioFiles,
  markStudioUploaded,
  removeStudioFile,
  replaceStudioFiles,
  resetStudioFiles,
  restoreStudioFiles,
} from '../src/lib/studio-files.js'

beforeEach(() => {
  sessionStorage.clear()
  resetStudioFiles()
})

describe('studio file session', () => {
  it('keeps a completed file in the session and restores it without the blob', () => {
    const file = new File(['hola'], 'toma.mp4', { type: 'video/mp4', lastModified: 0 })
    replaceStudioFiles([file])
    const key = currentStudioFiles().files[0].key
    markStudioUploaded(key, { sha256: 'ab', uploadId: 'upl-1', encargoId: 'enc-1' })
    const raw = sessionStorage.getItem('influ-studio-files')
    resetStudioFiles()
    sessionStorage.setItem('influ-studio-files', raw)
    const restored = restoreStudioFiles()
    expect(restored.encargoId).toBe('enc-1')
    expect(restored.files[0]).toMatchObject({
      name: 'toma.mp4',
      complete: true,
      uploadId: 'upl-1',
      sha256: 'ab',
      file: null,
    })
    const again = new File(['hola'], 'toma.mp4', { type: 'video/mp4', lastModified: 0 })
    replaceStudioFiles([again])
    expect(currentStudioFiles().files).toHaveLength(1)
    expect(currentStudioFiles().files[0].complete).toBe(true)
    expect(currentStudioFiles().files[0].file).toBe(again)
    removeStudioFile(currentStudioFiles().files[0].key)
    expect(currentStudioFiles().files).toEqual([])
  })
})
