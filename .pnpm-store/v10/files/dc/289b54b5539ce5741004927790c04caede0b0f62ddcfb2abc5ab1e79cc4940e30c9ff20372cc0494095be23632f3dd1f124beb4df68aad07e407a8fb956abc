import * as z from "zod/v4";
/**
 * A unique identifier for a conversation session between a client and agent.
 *
 * Sessions maintain their own context, conversation history, and state,
 * allowing multiple independent interactions with the same agent.
 *
 * See protocol docs: [Session ID](https://agentclientprotocol.com/protocol/session-setup#session-id)
 */
export declare const zSessionId: z.ZodString;
/**
 * Marker for `document/didOpen` capability support.
 */
export declare const zNesDocumentDidOpenCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * How the agent wants document changes delivered.
 */
export declare const zTextDocumentSyncKind: z.ZodUnion<readonly [z.ZodLiteral<"full">, z.ZodLiteral<"incremental">]>;
/**
 * Capabilities for `document/didChange` events.
 */
export declare const zNesDocumentDidChangeCapabilities: z.ZodObject<{
    syncKind: z.ZodUnion<readonly [z.ZodLiteral<"full">, z.ZodLiteral<"incremental">]>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Marker for `document/didClose` capability support.
 */
export declare const zNesDocumentDidCloseCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Marker for `document/didSave` capability support.
 */
export declare const zNesDocumentDidSaveCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Marker for `document/didFocus` capability support.
 */
export declare const zNesDocumentDidFocusCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Document event capabilities the agent wants to receive.
 */
export declare const zNesDocumentEventCapabilities: z.ZodObject<{
    didOpen: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    didChange: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        syncKind: z.ZodUnion<readonly [z.ZodLiteral<"full">, z.ZodLiteral<"incremental">]>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    didClose: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    didSave: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    didFocus: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Event capabilities the agent can consume.
 */
export declare const zNesEventCapabilities: z.ZodObject<{
    document: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        didOpen: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        didChange: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            syncKind: z.ZodUnion<readonly [z.ZodLiteral<"full">, z.ZodLiteral<"incremental">]>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        didClose: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        didSave: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        didFocus: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities for recent files context.
 */
export declare const zNesRecentFilesCapabilities: z.ZodObject<{
    maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities for related snippets context.
 */
export declare const zNesRelatedSnippetsCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities for edit history context.
 */
export declare const zNesEditHistoryCapabilities: z.ZodObject<{
    maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities for user actions context.
 */
export declare const zNesUserActionsCapabilities: z.ZodObject<{
    maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities for open files context.
 */
export declare const zNesOpenFilesCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities for diagnostics context.
 */
export declare const zNesDiagnosticsCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Context capabilities the agent wants attached to each suggestion request.
 */
export declare const zNesContextCapabilities: z.ZodObject<{
    recentFiles: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    relatedSnippets: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    editHistory: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    userActions: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    openFiles: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    diagnostics: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * NES capabilities advertised by the agent during initialization.
 */
export declare const zNesCapabilities: z.ZodObject<{
    events: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        document: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            didOpen: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>>>;
            didChange: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
                syncKind: z.ZodUnion<readonly [z.ZodLiteral<"full">, z.ZodLiteral<"incremental">]>;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>>>;
            didClose: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>>>;
            didSave: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>>>;
            didFocus: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>>>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    context: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        recentFiles: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        relatedSnippets: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        editHistory: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        userActions: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            maxCount: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodInt>>>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        openFiles: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        diagnostics: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * The encoding used for character offsets in positions.
 *
 * Follows the same conventions as LSP 3.17. The default is UTF-16.
 */
export declare const zPositionEncodingKind: z.ZodUnion<readonly [z.ZodLiteral<"utf-16">, z.ZodLiteral<"utf-32">, z.ZodLiteral<"utf-8">]>;
/**
 * Response to `nes/start`.
 */
export declare const zStartNesResponse: z.ZodObject<{
    sessionId: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Unique identifier for a next edit suggestion.
 */
export declare const zNesSuggestionId: z.ZodString;
/**
 * A zero-based position in a text document.
 *
 * The meaning of `character` depends on the negotiated position encoding.
 */
export declare const zPosition: z.ZodObject<{
    line: z.ZodInt;
    character: z.ZodInt;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A range in a text document, expressed as start and end positions.
 */
export declare const zRange: z.ZodObject<{
    start: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    end: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A text edit within a suggestion.
 */
export declare const zNesTextEdit: z.ZodObject<{
    range: z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    newText: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A text edit suggestion.
 */
export declare const zNesEditSuggestion: z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    edits: z.ZodArray<z.ZodObject<{
        range: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        newText: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>;
    cursorPosition: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A jump-to-location suggestion.
 */
export declare const zNesJumpSuggestion: z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A rename symbol suggestion.
 */
export declare const zNesRenameSuggestion: z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    newName: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A search-and-replace suggestion.
 */
export declare const zNesSearchAndReplaceSuggestion: z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    search: z.ZodString;
    replace: z.ZodString;
    isRegex: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A suggestion returned by the agent.
 */
export declare const zNesSuggestion: z.ZodUnion<readonly [z.ZodIntersection<z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    edits: z.ZodArray<z.ZodObject<{
        range: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        newText: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>;
    cursorPosition: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"edit">;
}, z.core.$strip>>, z.ZodIntersection<z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"jump">;
}, z.core.$strip>>, z.ZodIntersection<z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    newName: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"rename">;
}, z.core.$strip>>, z.ZodIntersection<z.ZodObject<{
    id: z.ZodString;
    uri: z.ZodString;
    search: z.ZodString;
    replace: z.ZodString;
    isRegex: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"searchAndReplace">;
}, z.core.$strip>>]>;
/**
 * Response to `nes/suggest`.
 */
export declare const zSuggestNesResponse: z.ZodObject<{
    suggestions: z.ZodArray<z.ZodUnion<readonly [z.ZodIntersection<z.ZodObject<{
        id: z.ZodString;
        uri: z.ZodString;
        edits: z.ZodArray<z.ZodObject<{
            range: z.ZodObject<{
                start: z.ZodObject<{
                    line: z.ZodInt;
                    character: z.ZodInt;
                    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
                }, z.core.$strip>;
                end: z.ZodObject<{
                    line: z.ZodInt;
                    character: z.ZodInt;
                    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
                }, z.core.$strip>;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            newText: z.ZodString;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>;
        cursorPosition: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"edit">;
    }, z.core.$strip>>, z.ZodIntersection<z.ZodObject<{
        id: z.ZodString;
        uri: z.ZodString;
        position: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"jump">;
    }, z.core.$strip>>, z.ZodIntersection<z.ZodObject<{
        id: z.ZodString;
        uri: z.ZodString;
        position: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        newName: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"rename">;
    }, z.core.$strip>>, z.ZodIntersection<z.ZodObject<{
        id: z.ZodString;
        uri: z.ZodString;
        search: z.ZodString;
        replace: z.ZodString;
        isRegex: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"searchAndReplace">;
    }, z.core.$strip>>]>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Response from closing an NES session.
 */
export declare const zCloseNesResponse: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Marker for jump suggestion support.
 */
export declare const zNesJumpCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Marker for rename suggestion support.
 */
export declare const zNesRenameCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Marker for search and replace suggestion support.
 */
export declare const zNesSearchAndReplaceCapabilities: z.ZodObject<{
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * NES capabilities advertised by the client during initialization.
 */
export declare const zClientNesCapabilities: z.ZodObject<{
    jump: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    rename: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    searchAndReplace: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A workspace folder.
 */
export declare const zWorkspaceFolder: z.ZodObject<{
    uri: z.ZodString;
    name: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Repository metadata for an NES session.
 */
export declare const zNesRepository: z.ZodObject<{
    name: z.ZodString;
    owner: z.ZodString;
    remoteUrl: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Request to start an NES session.
 */
export declare const zStartNesRequest: z.ZodObject<{
    workspaceUri: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    workspaceFolders: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        name: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    repository: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        name: z.ZodString;
        owner: z.ZodString;
        remoteUrl: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * What triggered the suggestion request.
 */
export declare const zNesTriggerKind: z.ZodUnion<readonly [z.ZodLiteral<"automatic">, z.ZodLiteral<"diagnostic">, z.ZodLiteral<"manual">]>;
/**
 * A recently accessed file.
 */
export declare const zNesRecentFile: z.ZodObject<{
    uri: z.ZodString;
    languageId: z.ZodString;
    text: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A code excerpt from a file.
 */
export declare const zNesExcerpt: z.ZodObject<{
    startLine: z.ZodInt;
    endLine: z.ZodInt;
    text: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A related code snippet from a file.
 */
export declare const zNesRelatedSnippet: z.ZodObject<{
    uri: z.ZodString;
    excerpts: z.ZodArray<z.ZodObject<{
        startLine: z.ZodInt;
        endLine: z.ZodInt;
        text: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * An entry in the edit history.
 */
export declare const zNesEditHistoryEntry: z.ZodObject<{
    uri: z.ZodString;
    diff: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A user action (typing, cursor movement, etc.).
 */
export declare const zNesUserAction: z.ZodObject<{
    action: z.ZodString;
    uri: z.ZodString;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    timestampMs: z.ZodNumber;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * An open file in the editor.
 */
export declare const zNesOpenFile: z.ZodObject<{
    uri: z.ZodString;
    languageId: z.ZodString;
    visibleRange: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    lastFocusedMs: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Severity of a diagnostic.
 */
export declare const zNesDiagnosticSeverity: z.ZodUnion<readonly [z.ZodLiteral<"error">, z.ZodLiteral<"warning">, z.ZodLiteral<"information">, z.ZodLiteral<"hint">]>;
/**
 * A diagnostic (error, warning, etc.).
 */
export declare const zNesDiagnostic: z.ZodObject<{
    uri: z.ZodString;
    range: z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    severity: z.ZodUnion<readonly [z.ZodLiteral<"error">, z.ZodLiteral<"warning">, z.ZodLiteral<"information">, z.ZodLiteral<"hint">]>;
    message: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Context attached to a suggestion request.
 */
export declare const zNesSuggestContext: z.ZodObject<{
    recentFiles: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        languageId: z.ZodString;
        text: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    relatedSnippets: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        excerpts: z.ZodArray<z.ZodObject<{
            startLine: z.ZodInt;
            endLine: z.ZodInt;
            text: z.ZodString;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    editHistory: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        diff: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    userActions: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        action: z.ZodString;
        uri: z.ZodString;
        position: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        timestampMs: z.ZodNumber;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    openFiles: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        languageId: z.ZodString;
        visibleRange: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        lastFocusedMs: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    diagnostics: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        range: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        severity: z.ZodUnion<readonly [z.ZodLiteral<"error">, z.ZodLiteral<"warning">, z.ZodLiteral<"information">, z.ZodLiteral<"hint">]>;
        message: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Request for a code suggestion.
 */
export declare const zSuggestNesRequest: z.ZodObject<{
    sessionId: z.ZodString;
    uri: z.ZodString;
    version: z.ZodNumber;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    selection: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>;
    triggerKind: z.ZodUnion<readonly [z.ZodLiteral<"automatic">, z.ZodLiteral<"diagnostic">, z.ZodLiteral<"manual">]>;
    context: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        recentFiles: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            languageId: z.ZodString;
            text: z.ZodString;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        relatedSnippets: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            excerpts: z.ZodArray<z.ZodObject<{
                startLine: z.ZodInt;
                endLine: z.ZodInt;
                text: z.ZodString;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        editHistory: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            diff: z.ZodString;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        userActions: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            action: z.ZodString;
            uri: z.ZodString;
            position: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            timestampMs: z.ZodNumber;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        openFiles: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            languageId: z.ZodString;
            visibleRange: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodObject<{
                start: z.ZodObject<{
                    line: z.ZodInt;
                    character: z.ZodInt;
                    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
                }, z.core.$strip>;
                end: z.ZodObject<{
                    line: z.ZodInt;
                    character: z.ZodInt;
                    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
                }, z.core.$strip>;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>>>>;
            lastFocusedMs: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        diagnostics: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            range: z.ZodObject<{
                start: z.ZodObject<{
                    line: z.ZodInt;
                    character: z.ZodInt;
                    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
                }, z.core.$strip>;
                end: z.ZodObject<{
                    line: z.ZodInt;
                    character: z.ZodInt;
                    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
                }, z.core.$strip>;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            severity: z.ZodUnion<readonly [z.ZodLiteral<"error">, z.ZodLiteral<"warning">, z.ZodLiteral<"information">, z.ZodLiteral<"hint">]>;
            message: z.ZodString;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Request to close an NES session.
 *
 * The agent **must** cancel any ongoing work related to the NES session
 * and then free up any resources associated with the session.
 */
export declare const zCloseNesRequest: z.ZodObject<{
    sessionId: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Notification sent when a file is opened in the editor.
 */
export declare const zDidOpenDocumentNotification: z.ZodObject<{
    sessionId: z.ZodString;
    uri: z.ZodString;
    languageId: z.ZodString;
    version: z.ZodNumber;
    text: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * A content change event for a document.
 *
 * When `range` is `None`, `text` is the full content of the document.
 * When `range` is `Some`, `text` replaces the given range.
 */
export declare const zTextDocumentContentChangeEvent: z.ZodObject<{
    range: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>>;
    text: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Notification sent when a file is edited.
 */
export declare const zDidChangeDocumentNotification: z.ZodObject<{
    sessionId: z.ZodString;
    uri: z.ZodString;
    version: z.ZodNumber;
    contentChanges: z.ZodArray<z.ZodObject<{
        range: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodInt;
                character: z.ZodInt;
                _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
            }, z.core.$strip>;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>>>;
        text: z.ZodString;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Notification sent when a file is closed.
 */
export declare const zDidCloseDocumentNotification: z.ZodObject<{
    sessionId: z.ZodString;
    uri: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Notification sent when a file is saved.
 */
export declare const zDidSaveDocumentNotification: z.ZodObject<{
    sessionId: z.ZodString;
    uri: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Notification sent when a file becomes the active editor tab.
 */
export declare const zDidFocusDocumentNotification: z.ZodObject<{
    sessionId: z.ZodString;
    uri: z.ZodString;
    version: z.ZodNumber;
    position: z.ZodObject<{
        line: z.ZodInt;
        character: z.ZodInt;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    visibleRange: z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodInt;
            character: z.ZodInt;
            _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        }, z.core.$strip>;
        _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
    }, z.core.$strip>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * Notification sent when a suggestion is accepted.
 */
export declare const zAcceptNesNotification: z.ZodObject<{
    sessionId: z.ZodString;
    id: z.ZodString;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
/**
 * The reason a suggestion was rejected.
 */
export declare const zNesRejectReason: z.ZodUnion<readonly [z.ZodLiteral<"rejected">, z.ZodLiteral<"ignored">, z.ZodLiteral<"replaced">, z.ZodLiteral<"cancelled">]>;
/**
 * Notification sent when a suggestion is rejected.
 */
export declare const zRejectNesNotification: z.ZodObject<{
    sessionId: z.ZodString;
    id: z.ZodString;
    reason: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"rejected">, z.ZodLiteral<"ignored">, z.ZodLiteral<"replaced">, z.ZodLiteral<"cancelled">]>>>>;
    _meta: z.ZodCatch<z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
}, z.core.$strip>;
