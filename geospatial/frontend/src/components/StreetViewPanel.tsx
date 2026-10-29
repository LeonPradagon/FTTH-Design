import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, MapPinned, X } from 'lucide-react'
import { Button } from './ui/button'

type StreetViewLocation = {
  lat: number
  lng: number
}

type StreetViewPanelProps = {
  apiKey?: string
  location: StreetViewLocation
  onClose: () => void
}

type GoogleMapsStreetViewStatus = 'OK' | 'ZERO_RESULTS' | 'UNKNOWN_ERROR'

type GoogleMapsNamespace = {
  maps: {
    StreetViewPanorama: new (
      element: HTMLElement,
      options: {
        addressControl?: boolean
        fullscreenControl?: boolean
        linksControl?: boolean
        panControl?: boolean
        position?: unknown
        pov?: { heading: number; pitch: number }
        zoomControl?: boolean
      },
    ) => { setVisible: (visible: boolean) => void }
    StreetViewService: new () => {
      getPanorama: (
        request: {
          location: StreetViewLocation
          preference: string
          radius: number
          source: string
        },
        callback: (
          data: { location?: { latLng?: unknown } } | null,
          status: GoogleMapsStreetViewStatus,
        ) => void,
      ) => void
    }
    StreetViewPreference: { NEAREST: string }
    StreetViewSource: { OUTDOOR: string }
    StreetViewStatus: { OK: GoogleMapsStreetViewStatus }
  }
}

declare global {
  interface Window {
    google?: GoogleMapsNamespace
  }
}

let googleMapsPromise: Promise<GoogleMapsNamespace> | null = null

function loadGoogleMaps(apiKey: string) {
  if (window.google?.maps) {
    return Promise.resolve(window.google)
  }

  if (googleMapsPromise) {
    return googleMapsPromise
  }

  googleMapsPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-google-maps-street-view="true"]',
    )

    if (existingScript) {
      existingScript.addEventListener('load', () => {
        if (window.google?.maps) {
          resolve(window.google)
        } else {
          reject(new Error('Google Maps loaded without the maps namespace.'))
        }
      })
      existingScript.addEventListener('error', () => {
        reject(new Error('Unable to load Google Maps.'))
      })
      return
    }

    const script = document.createElement('script')
    script.async = true
    script.defer = true
    script.dataset.googleMapsStreetView = 'true'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`
    script.onload = () => {
      if (window.google?.maps) {
        resolve(window.google)
      } else {
        reject(new Error('Google Maps loaded without the maps namespace.'))
      }
    }
    script.onerror = () => reject(new Error('Unable to load Google Maps.'))
    document.head.appendChild(script)
  })

  return googleMapsPromise
}

export function StreetViewPanel({ apiKey, location, onClose }: StreetViewPanelProps) {
  const panoramaRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing-key' | 'not-found' | 'error'>(
    apiKey ? 'loading' : 'missing-key',
  )
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let panorama: { setVisible: (visible: boolean) => void } | null = null

    if (!apiKey) {
      setStatus('missing-key')
      setMessage('Set VITE_GOOGLE_MAPS_API_KEY to enable Street View.')
      return
    }

    setStatus('loading')
    setMessage('Searching for nearby Street View imagery...')

    loadGoogleMaps(apiKey)
      .then((google) => {
        if (cancelled) {
          return
        }

        const service = new google.maps.StreetViewService()
        service.getPanorama(
          {
            location,
            preference: google.maps.StreetViewPreference.NEAREST,
            radius: 80,
            source: google.maps.StreetViewSource.OUTDOOR,
          },
          (data, streetViewStatus) => {
            if (cancelled) {
              return
            }

            if (
              streetViewStatus !== google.maps.StreetViewStatus.OK ||
              !data?.location?.latLng ||
              !panoramaRef.current
            ) {
              setStatus('not-found')
              setMessage('No outdoor Street View panorama found within 80 meters.')
              return
            }

            panorama = new google.maps.StreetViewPanorama(panoramaRef.current, {
              addressControl: false,
              fullscreenControl: true,
              linksControl: true,
              panControl: true,
              position: data.location.latLng,
              pov: { heading: 0, pitch: 0 },
              zoomControl: true,
            })
            setStatus('ready')
            setMessage(null)
          },
        )
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }

        setStatus('error')
        setMessage(error instanceof Error ? error.message : 'Unable to open Street View.')
      })

    return () => {
      cancelled = true
      panorama?.setVisible(false)
    }
  }, [apiKey, location])

  return (
    <aside className="absolute bottom-4 right-16 top-20 z-30 flex w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">Street View</p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          onClick={onClose}
          aria-label="Close Street View"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 bg-slate-100">
        <div ref={panoramaRef} className="absolute inset-0" />

        {status !== 'ready' ? (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/6 p-6 text-center">
            <div className="max-w-72 rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-sm">
              {status === 'loading' ? (
                <LoaderCircle className="mx-auto size-6 animate-spin text-slate-500" />
              ) : (
                <MapPinned className="mx-auto size-6 text-slate-500" />
              )}
              <p className="mt-3 text-sm font-semibold text-slate-900">
                {status === 'loading'
                  ? 'Opening nearby panorama'
                  : status === 'missing-key'
                    ? 'Google API key required'
                    : status === 'not-found'
                      ? 'No Street View nearby'
                      : 'Street View unavailable'}
              </p>
              {message ? <p className="mt-1 text-xs leading-5 text-slate-500">{message}</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
