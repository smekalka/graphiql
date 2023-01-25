import { visit, OperationTypeNode, GraphQLError } from 'graphql';

import { gql } from 'graphql-tag';
import { fetch } from '@whatwg-node/fetch';
import { Agent } from 'https';
import { WebSocket } from 'ws';
import { pipe, subscribe, fromObservable } from 'wonka';

// eslint-disable-next-line import/no-unresolved
import { Endpoint } from 'graphql-config/typings/extensions/endpoints';
import { OutputChannel, workspace, WorkspaceConfiguration } from 'vscode';
import { GraphQLProjectConfig } from 'graphql-config';
import { createClient as createWSClient, OperationResult } from 'graphql-ws';
import { SubscriptionClient } from '@shopify/legacy-apollo-subscriptions-transport';

import {
  CombinedError,
  createClient,
  defaultExchanges,
  subscriptionExchange,
} from '@urql/core';

import {
  ExtractedTemplateLiteral,
  SourceHelper,
  getFragmentDependenciesForAST,
} from './source';

import { UserVariables } from '../providers/exec-content';

export class NetworkHelper {
  private useLegacySubscriptionsClient: boolean;
  private outputChannel: OutputChannel;
  private sourceHelper: SourceHelper;

  constructor(
    outputChannel: OutputChannel,
    sourceHelper: SourceHelper,
    config: WorkspaceConfiguration,
  ) {
    this.outputChannel = outputChannel;
    this.sourceHelper = sourceHelper;
    this.useLegacySubscriptionsClient = config.get(
      'useLegacySubscriptionsClient',
      false,
    );
  }

  private buildSubscriptionUrl(endpoint: Endpoint) {
    let wsEndpointURL = endpoint.url.replace(/^http/, 'ws');
    if (this.useLegacySubscriptionsClient) {
      wsEndpointURL = wsEndpointURL.replace(/\/graphql\/?$/, '/subscriptions');
    }

    const params: string[] = [];
    for (const header in endpoint.headers) {
      const headerLower = header.toLowerCase();
      const values = endpoint.headers[header];
      const value = Array.isArray(values) ? values[0] : values;
      if (headerLower === 'authorization') {
        const segments = value.split(/\s+/);
        if (segments[0] === 'Bearer') {
          params.push(`access_token=${segments[1]}`);
        }
      } else if (headerLower.startsWith('x-')) {
        params.push(`${header.substring(2).replaceAll('-', '_')}=${value}`);
      }
    }
    return wsEndpointURL + (params.length > 0 ? '?' + params.join('&') : '');
  }

  private buildClient({
    operation,
    endpoint,
  }: // updateCallback,
  {
    operation: string;
    endpoint: Endpoint;
    updateCallback: (data: string, operation: string) => void;
  }) {
    const { rejectUnauthorized } = workspace.getConfiguration('vscode-graphql');
    // this is a node specific setting that can allow requests against servers using self-signed certificates
    // it is similar to passing the nodejs env variable flag, except configured on a per-request basis here
    const agent = new Agent({ rejectUnauthorized });

    const exchanges = [...defaultExchanges];

    if (operation === 'subscription') {
      const url = this.buildSubscriptionUrl(endpoint);
      const wsClient = createWSClient({
        url,
        connectionAckWaitTimeout: 3000,
        webSocketImpl: WebSocket,
      });
      exchanges.push(
        subscriptionExchange({
          forwardSubscription: op => ({
            subscribe: sink => ({
              unsubscribe: wsClient.subscribe(op, sink),
            }),
          }),
        }),
      );
    }

    return createClient({
      url: endpoint.url,
      fetch: global.fetch ?? fetch,
      fetchOptions: {
        headers: endpoint.headers as HeadersInit,
        // this is an option that's only available in `node-fetch`, not in the standard fetch API
        // @ts-expect-error
        agent: new URL(endpoint.url).protocol === 'https:' ? agent : undefined,
      },
      exchanges,
    });
  }

  buildSubscribeConsumer =
    (cb: ExecuteOperationOptions['updateCallback'], operation: string) =>
    (result: OperationResult) => {
      const { errors, data, error } = result as {
        error?: CombinedError;
        errors?: GraphQLError[];
        data?: unknown;
      };
      if (errors || data) {
        cb(formatData(result), operation);
      }
      if (error) {
        if (error.graphQLErrors && error.graphQLErrors.length > 0) {
          cb(
            JSON.stringify({ errors: error.graphQLErrors }, null, 2),
            operation,
          );
        }
        if (error.networkError) {
          cb(error.networkError.message, operation);
        }
      }
    };

  async executeOperation({
    endpoint,
    literal,
    variables,
    updateCallback,
    projectConfig,
  }: ExecuteOperationOptions) {
    const operationTypes: OperationTypeNode[] = [];
    const operationNames: string[] = [];

    visit(literal.ast, {
      OperationDefinition(node) {
        operationTypes.push(node.operation);
        operationNames.push(node.name?.value || '');
      },
    });
    const fragmentDefinitions = await this.sourceHelper.getFragmentDefinitions(
      projectConfig,
    );

    const fragmentInfos = await getFragmentDependenciesForAST(
      literal.ast,
      fragmentDefinitions,
    );

    fragmentInfos.forEach(fragmentInfo => {
      literal.content = fragmentInfo.content + '\n' + literal.content;
    });

    const parsedOperation = gql`
      ${literal.content}
    `;
    return Promise.all(
      operationTypes.map(async operation => {
        const subscriber = this.buildSubscribeConsumer(
          updateCallback,
          operation,
        );
        this.outputChannel.appendLine(`NetworkHelper: operation: ${operation}`);
        this.outputChannel.appendLine(
          `NetworkHelper: endpoint: ${endpoint.url}`,
        );
        try {
          if (
            operation === 'subscription' &&
            this.useLegacySubscriptionsClient
          ) {
            const subClient = new SubscriptionClient(
              this.buildSubscriptionUrl(endpoint),
              { reconnect: true },
              WebSocket,
            );
            subClient.onError(err =>
              updateCallback(`Error: ${err.message}`, operation),
            );
            const sub = subClient.request({
              query: literal.content,
              variables,
            });
            pipe(
              fromObservable(sub),
              subscribe(result =>
                updateCallback(JSON.stringify(result, null, 2), operation),
              ),
            );
          } else {
            const urqlClient = this.buildClient({
              operation,
              endpoint,
              updateCallback,
            });
            if (operation === 'subscription') {
              pipe(
                urqlClient.subscription(parsedOperation, variables),
                subscribe(subscriber),
              );
            } else if (operation === 'query') {
              pipe(
                urqlClient.query(parsedOperation, variables),
                subscribe(subscriber),
              );
            } else {
              pipe(
                urqlClient.mutation(parsedOperation, variables),
                subscribe(subscriber),
              );
            }
          }
        } catch (err) {
          this.outputChannel.appendLine(`error executing operation:\n${err}`);
        }
      }),
    );
  }
}

export interface ExecuteOperationOptions {
  endpoint: Endpoint;
  literal: ExtractedTemplateLiteral;
  variables: UserVariables;
  updateCallback: (data: string, operation: string) => void;
  projectConfig: GraphQLProjectConfig;
}

function formatData({ data, errors }: any) {
  return JSON.stringify({ data, errors }, null, 2);
}
