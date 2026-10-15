import { defineDescriptor } from '../definition';
import { GrokAdapter } from './adapter';
import { grokMetadata } from './metadata';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';
import { grokStderrSignatures } from './stderr-signatures';

export const grokDescriptor = defineDescriptor({
  ...grokMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: async () => [],
  detectionOrder: 0,
  stderrSignatures: grokStderrSignatures,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: (command) => command
    ? resolveExecutablePath(command)
    : resolveFirstAvailableBinary(grokMetadata.binaryNames),
  create: ({ profile, larkChannel }) => new GrokAdapter({
    binary: profile.agent.binaryPath ?? grokMetadata.binaryNames[0],
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
