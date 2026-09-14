import React from 'react';
import {Composition, registerRoot} from 'remotion';
import story from '../props/story.json';
import {BetterCodexVideo, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH, VIDEO_DURATION} from './BetterCodexVideo';

const RemotionRoot: React.FC = () => (
  <Composition
    id="BetterCodexExplainer"
    component={BetterCodexVideo}
    durationInFrames={VIDEO_DURATION}
    fps={VIDEO_FPS}
    width={VIDEO_WIDTH}
    height={VIDEO_HEIGHT}
    defaultProps={{story}}
  />
);

registerRoot(RemotionRoot);
