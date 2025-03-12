import { createFileRoute } from '@tanstack/react-router'
import { ScoreViewer } from '~/components/ScoreViewer'

export const Route = createFileRoute('/sequence/')({
  component: SequenceIndexComponent,
})

function SequenceIndexComponent() {
  return <div>
      <div id="score"></div>
      <ScoreViewer />
    </div>
}
