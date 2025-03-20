import { createFileRoute } from '@tanstack/react-router'
import { ScoreViewer } from '~/components/ScoreViewer'
import { ScoreView } from '~/components/ScoreView'
// import { PercussionScore } from '~/components/PercussionScore'
import { BeatView } from '~/components/BeatView'

export const Route = createFileRoute('/sequence/')({
  component: SequenceIndexComponent,
})

function SequenceIndexComponent() {
  return <div>
      {/* <div id="percussionscore" className="h-full w-full border-2 border-gray-100 bg-pink-50">
        <PercussionScore />
      </div> */}
      <div id="scoreview" className="h-full w-full border-2 border-purple-700 bg-pink-50">
        <ScoreView />
      </div>
      {/* <div id="scoreviewer" className="h-full w-full border-2 border-gray-100 bg-purple-200"> */}
        {/* <ScoreViewer /> */}
      {/* </div> */}
      <div id="beatview" className="h-full w-full border-2 border-gray-100 bg-pink-50">
        {/* <BeatView /> */}
      </div>
      <div className='bg-green-200 w-full h-2'></div>
    </div>
}
