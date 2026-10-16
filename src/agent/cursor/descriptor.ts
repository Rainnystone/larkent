import { defineDescriptor } from '../definition';
import { CursorAdapter } from './adapter';
import { cursorMetadata } from './metadata';
import { detectCursorBinary } from './detection';
import { cursorStderrSignatures } from './stderr-signatures';

export const cursorDescriptor = defineDescriptor({
  ...cursorMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: async () => [],
  detectionOrder: 4,
  stderrSignatures: cursorStderrSignatures,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: detectCursorBinary,
  create: ({ profile, larkChannel }) => new CursorAdapter({
    ...(profile.agent.binaryPath ? { binary: profile.agent.binaryPath } : {}),
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
