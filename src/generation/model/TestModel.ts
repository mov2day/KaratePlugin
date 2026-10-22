// Source-neutral model produced by parsers and consumed by the generation pipeline.
// Pure types only: no vscode, no I/O.

export type SourceKind = 'openapi' | 'postman' | 'har' | 'graphql' | 'jira' | 'confluence' | 'combined' | 'scout' | 'session';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonSchema = Record<string, any>;

export interface SecurityScheme {
    name: string;
    kind: 'basic' | 'bearer' | 'apiKey' | 'oauth2' | 'openIdConnect';
    in?: 'header' | 'query' | 'cookie';
    paramName?: string;
    tokenUrl?: string;
    /** oauth2 only: the flow the spec declares (clientCredentials preferred when several). */
    flow?: 'clientCredentials' | 'password' | 'authorizationCode' | 'implicit';
}

export interface ParamModel {
    name: string;
    required: boolean;
    schema: JsonSchema;
    example?: unknown;
}

export interface BodyModel {
    contentType: string;
    schema?: JsonSchema;
    example?: unknown;
}

export interface ResponseModel {
    status: string;
    schema?: JsonSchema;
    contentType?: string;
    example?: unknown;
}

export interface OperationModel {
    id: string;
    method: string;
    path: string;
    summary?: string;
    tags: string[];
    pathParams: ParamModel[];
    queryParams: ParamModel[];
    headerParams: ParamModel[];
    body?: BodyModel;
    responses: ResponseModel[];
    security: string[] | 'none' | 'inherit';
    /** Requirement groups: schemes inside a group are ANDed, groups are ORed. Absent when the operation has no named requirement. */
    securityGroups?: string[][];
    sourceRef: string;
}

export interface GenerationModel {
    source: SourceKind;
    name: string;
    baseUrl?: string;
    schemes: SecurityScheme[];
    operations: OperationModel[];
    unsupported: { sourceRef: string; reason: string }[];
}
