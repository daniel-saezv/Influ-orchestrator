import { Upload, X } from 'lucide-react'

export function KeptFiles({ files, onRemove, renderPreview }) {
  if (!files.length) return null
  const uploaded = files.some((entry) => entry.complete)
  return (
    <div className="stack">
      <div className="thumbs">
        {files.map((entry) => (
          <div className="thumb-wrap" key={entry.key}>
            {entry.file && renderPreview ? renderPreview(entry.file) : (
              <div className="thumb thumb-file"><Upload aria-hidden="true" /><span>{entry.name}</span></div>
            )}
            {entry.complete && <span className="thumb-state">Subido</span>}
            <button type="button" className="thumb-remove" aria-label={`Quitar ${entry.name}`} onClick={() => onRemove(entry)}>
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {uploaded && <p className="fine">Los archivos ya subidos se reutilizan. Puedes quitarlos.</p>}
    </div>
  )
}
