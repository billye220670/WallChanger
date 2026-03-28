import { useState } from 'react'
import { useStore } from '../store'
import { setBackendUrl as apiSetBackendUrl, checkHealth } from '../utils/api'

interface SettingsDrawerProps {
  open: boolean
  onClose: () => void
}

type ConnectionStatus = 'idle' | 'testing' | 'ok' | 'error'

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const { backendUrl, setBackendUrl } = useStore()
  const [url, setUrl] = useState(backendUrl)
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [modelLoaded, setModelLoaded] = useState(false)

  async function testConnection() {
    setStatus('testing')
    try {
      apiSetBackendUrl(url)
      const result = await checkHealth()
      setModelLoaded(result.model_loaded)
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }

  function handleSave() {
    setBackendUrl(url)
    apiSetBackendUrl(url)
    onClose()
  }

  return (
    <>
      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-40"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed inset-y-0 right-0 w-80 bg-gray-900 z-50 shadow-2xl transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between p-4 border-b border-gray-800">
            <h2 className="text-white font-semibold">设置</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 p-4 space-y-4">
            <div>
              <label className="text-gray-400 text-sm block mb-1">后端地址</label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:8100"
                className="w-full bg-gray-800 text-white rounded-lg px-3 py-2 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
              />
              <p className="text-gray-600 text-xs mt-1">手机访问时填入电脑本机IP</p>
            </div>

            <button
              onClick={testConnection}
              disabled={status === 'testing'}
              className="w-full bg-gray-800 hover:bg-gray-700 text-white rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
            >
              {status === 'testing' ? '测试中...' : '测试连接'}
            </button>

            {status === 'ok' && (
              <div className="bg-green-900/30 border border-green-700 rounded-lg p-3 text-sm">
                <p className="text-green-400 font-medium">连接成功</p>
                <p className="text-green-600 text-xs mt-1">
                  {modelLoaded ? 'SAM3 模型已加载' : 'SAM3 正在加载，请稍候'}
                </p>
              </div>
            )}

            {status === 'error' && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm">
                <p className="text-red-400 font-medium">连接失败</p>
                <p className="text-red-600 text-xs mt-1">请确认后端已启动</p>
              </div>
            )}
          </div>

          <div className="p-4 border-t border-gray-800">
            <button
              onClick={handleSave}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2 font-medium transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
