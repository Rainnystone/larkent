import { listClaudeResumeHistory } from './history';
import { defineDescriptor } from '../definition';
import { ClaudeAdapter } from './adapter';
import { claudeMetadata } from './metadata';
import { resolveExecutablePath, resolveFirstAvailableBinary } from '../../platform/executable';

export const claudeDescriptor = defineDescriptor({
  ...claudeMetadata,
  acceptsImagePaths: false,
  acceptsRawResumeHandle: true,
  listResumeHistory: listClaudeResumeHistory,
  detectionOrder: 1,
  resolveProfileBinary: (profile) => profile.agent.binaryPath,
  detectBinary: (command) => command
    ? resolveExecutablePath(command)
    : resolveFirstAvailableBinary(claudeMetadata.binaryNames),
  create: ({ profile, larkChannel }) => new ClaudeAdapter({
    binary: profile.agent.binaryPath ?? claudeMetadata.binaryNames[0],
    agentOptions: profile.agent.options,
    larkChannel,
  }),
});
