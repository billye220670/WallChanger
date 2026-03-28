import { useStore } from './store'
import { UploadScreen } from './screens/UploadScreen'
import { ProcessingScreen } from './screens/ProcessingScreen'
import { EditorScreen } from './screens/EditorScreen'
import { FinalizingScreen } from './screens/FinalizingScreen'
import { ResultSheet } from './screens/ResultSheet'

export default function App() {
  const { phase } = useStore()

  return (
    <>
      {phase === 'upload' && <UploadScreen />}
      {phase === 'processing' && <ProcessingScreen />}
      {phase === 'editing' && <EditorScreen />}
      {phase === 'finalizing' && <FinalizingScreen />}
      {phase === 'done' && (
        <>
          <EditorScreen />
          <ResultSheet />
        </>
      )}
    </>
  )
}
