import { defineDescriptor } from '../definition';
import { AntigravityAdapter } from './adapter';
import { antigravityMetadata } from './metadata';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';

export const antigravityDescriptor = defineDescriptor({
  ...antigravityMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: async () => [],
  detectionOrder: 5,
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
