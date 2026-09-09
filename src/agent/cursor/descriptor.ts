import { defineDescriptor } from '../definition';
import { CursorAdapter } from './adapter';
import { cursorMetadata } from './metadata';
import { detectCursorBinary } from './detection';

export const cursorDescriptor = defineDescriptor({
  ...cursorMetadata,
  detectionOrder: 4,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: detectCursorBinary,
  create: ({ profile, larkChannel }) => new CursorAdapter({
    ...(profile.agent.binaryPath ? { binary: profile.agent.binaryPath } : {}),
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
