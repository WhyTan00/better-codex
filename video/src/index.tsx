import React from 'react';
import {Composition, registerRoot} from 'remotion';
import story from '../props/story.json';
import storyZh from '../props/story.zh-CN.json';
import {BetterCodexVideo, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH, VIDEO_DURATION} from './BetterCodexVideo';
import {BetterCodexZhVertical, ZH_VERTICAL_DURATION, ZH_VERTICAL_FPS, ZH_VERTICAL_HEIGHT, ZH_VERTICAL_WIDTH} from './BetterCodexZhVertical';

const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="BetterCodexExplainer"
      component={BetterCodexVideo}
      durationInFrames={VIDEO_DURATION}
      fps={VIDEO_FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
      defaultProps={{story}}
    />
    <Composition
      id="BetterCodexZhVertical"
      component={BetterCodexZhVertical}
      durationInFrames={ZH_VERTICAL_DURATION}
      fps={ZH_VERTICAL_FPS}
      width={ZH_VERTICAL_WIDTH}
      height={ZH_VERTICAL_HEIGHT}
      defaultProps={{story: storyZh}}
    />
  </>
);

registerRoot(RemotionRoot);
