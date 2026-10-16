import { defineDescriptor } from '../definition';
import { AntigravityAdapter } from './adapter';
import { antigravityMetadata } from './metadata';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';
import { antigravityStderrSignatures } from './stderr-signatures';

export const antigravityDescriptor = defineDescriptor({
  ...antigravityMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: async () => [],
  detectionOrder: 5,
  stderrSignatures: antigravityStderrSignatures,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: (command) => command
    ? resolveExecutablePath(command)
    : resolveFirstAvailableBinary(antigravityMetadata.binaryNames),
  create: ({ profile, larkChannel }) => new AntigravityAdapter({
    binary: profile.agent.binaryPath ?? antigravityMetadata.binaryNames[0],
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
