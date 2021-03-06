/*
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

/// <reference path="../../../../../../third_party/externs/ts/gapi/bigquery.d.ts" />
/// <reference path="../../../../../../third_party/externs/ts/gapi/drive.d.ts" />

class MissingClientIdError extends Error {
  message = 'No oauth2ClientId found in user or config settings';
}

enum GapiScopes {
  BIGQUERY,
  DRIVE,
  GCS,
}

const initialScopeString = 'profile email';

/**
 * This module contains a collection of functions that interact with gapi.
 */
class GapiManager {

  public static drive = class {

    public static getRoot(): Promise<gapi.client.drive.File> {
      const request: gapi.client.drive.GetFileRequest = {
        fileId: 'root',
      };
      return this._load()
        .then(() => gapi.client.drive.files.get(request))
        .then((response) => JSON.parse(response.body));
    }

    public static getFiles(fileFields: string[], queryPredicates: string[], orderBy?: string[]):
        Promise<gapi.client.drive.File[]> {
      return this._load()
        .then(() => gapi.client.drive.files.list({
          fields: 'nextPageToken, files(' + fileFields.join(',') + ')',
          orderBy: orderBy ? orderBy.join(',') : '',
          pageSize: 30,
          q: queryPredicates.join(' and '),
        }))
        .then((response: HttpResponse<gapi.client.drive.ListFilesResponse>) => {
          return response.result.files;
        }, (response: HttpResponse<{error: Error}>) => {
          throw response.result.error;
        });
    }

    private static _load(): Promise<void> {
      return GapiManager.loadGapi()
        .then(() => gapi.client.load('drive', 'v3'))
        .then(() => GapiManager.grantScope(GapiScopes.DRIVE));
    }

  };

  public static bigquery = class {

    /**
     * Gets the list of BigQuery projects, returns a Promise.
     */
    public static listProjects(pageToken?: string):
        Promise<gapi.client.HttpRequestFulfilled<gapi.client.bigquery.ListProjectsResponse>> {
      const request = {
        maxResults: 1000,
        pageToken,
      } as gapi.client.bigquery.ListProjectsRequest;
      return this._load()
        .then(() => gapi.client.bigquery.projects.list(request));
    }

    /**
     * Gets the list of BigQuery datasets in the specified project, returns a Promise.
     * @param projectId
     * @param filter A label filter of the form label.<name>[:<value>], as described in
     *     https://cloud.google.com/bigquery/docs/reference/rest/v2/datasets/list
     */
    public static listDatasets(projectId: string, filter: string,
        pageToken?: string):
        Promise<gapi.client.HttpRequestFulfilled<gapi.client.bigquery.ListDatasetsResponse>> {
      const request = {
        filter,
        maxResults: 1000,
        pageToken,
        projectId,
      } as gapi.client.bigquery.ListDatasetsRequest;
      return this._load()
        .then(() => gapi.client.bigquery.datasets.list(request));
    }

    /**
     * Gets the list of BigQuery tables in the specified project and dataset,
     * returns a Promise.
     */
    public static listTables(projectId: string, datasetId: string,
        pageToken?: string):
        Promise<gapi.client.HttpRequestFulfilled<gapi.client.bigquery.ListTablesResponse>> {
      const request = {
        datasetId,
        maxResults: 1000,
        pageToken,
        projectId,
      } as gapi.client.bigquery.ListTablesRequest;
      return this._load()
        .then(() => gapi.client.bigquery.tables.list(request));
    }

    /**
     * Fetches table details from BigQuery
     */
    public static getTableDetails(projectId: string, datasetId: string, tableId: string):
        Promise<gapi.client.HttpRequestFulfilled<gapi.client.bigquery.Table>> {
      const request = {
        datasetId,
        projectId,
        tableId,
      };
      return this._load()
        .then(() => gapi.client.bigquery.tables.get(request));
    }

    private static _load(): Promise<void> {
      return GapiManager.loadGapi()
        .then(() => gapi.client.load('bigquery', 'v2'))
        .then(() => GapiManager.grantScope(GapiScopes.BIGQUERY));
    }

  };

  private static _clientId = '';   // Gets set by _loadClientId()
  private static _loadPromise: Promise<void>;

  /**
   * Request a new scope to be granted.
   */
  public static async grantScope(scope: GapiScopes): Promise<any> {
    await this.loadGapi();
    const currentUser = gapi.auth2.getAuthInstance().currentUser.get();
    if (!currentUser.hasGrantedScopes(this._getScopeString(scope))) {
      return new Promise((resolve, reject) => {
        const options = new gapi.auth2.SigninOptionsBuilder();
        options.setScope(this._getScopeString(scope));
        gapi.auth2.getAuthInstance().signIn(options)
          .then(() => {
            resolve();
          }, () => reject());
      });
    }
    return Promise.resolve();
  }

  /**
   * Loads the gapi module and the auth2 modules. This can be called multiple
   * times, and it will only load the gapi module once.
   * @param signInChangedCallback callback to be called when the signed-in state changes
   * @returns a promise that completes when the load is done or has failed
   */
   public static loadGapi(): Promise<void> {
    // Loads the gapi client library and the auth2 library together for efficiency.
    // Loading the auth2 library is optional here since `gapi.client.init` function will load
    // it if not already loaded. Loading it upfront can save one network request.
    if (!this._loadPromise) {
      this._loadPromise = new Promise((resolve, reject) => {
        return this._loadClientId()
          .then(() => gapi.load('client:auth2', resolve))
          .catch((e: Error) => {
            if (e instanceof MissingClientIdError) {
              Utils.log.error(e.message);
            }
            reject(e);
          });
      })
      .then(() => this._initClient());
    }

    return this._loadPromise;
  }

  /**
   * Starts the sign-in flow using gapi.
   * If the user has not previously authorized our app, this will open a pop-up window
   * to ask the user to select an account and to consent to our use of the scopes.
   * If the user has previously signed in and the doPrompt flag is false, the pop-up will
   * appear momentarily before automatically closing. If the doPrompt flag is set, then
   * the user will be prompted as if authorization has not previously been provided.
   */
   public static signIn(doPrompt: boolean): Promise<gapi.auth2.GoogleUser> {
    const rePromptOptions = 'login consent select_account';
    const promptFlags = doPrompt ? rePromptOptions : '';
    const options = {
      prompt: promptFlags,
    };
    return this.loadGapi()
      .then(() => gapi.auth2.getAuthInstance().signIn(options));
  }

  /**
   * Signs the user out using gapi.
   */
   public static signOut(): Promise<void> {
    return this.loadGapi()
      .then(() => gapi.auth2.getAuthInstance().signOut());
  }

  /**
   * Returns a promise that resolves to the signed-in user's email address.
   */
  public static getSignedInEmail(): Promise<string> {
    return this.loadGapi()
      .then(() => gapi.auth2.getAuthInstance().currentUser.get().getBasicProfile().getEmail());
  }

  /**
   * Observes changes to the sign in status, and calls the provided callback
   * with the changes.
   */
  public static listenForSignInChanges(signInChangedCallback: (signedIn: boolean) => void):
      Promise<void> {
    return this.loadGapi()
      .then(() => {
        // Initialize the callback now
        signInChangedCallback(gapi.auth2.getAuthInstance().isSignedIn.get());

        // Listen for auth changes
        gapi.auth2.getAuthInstance().isSignedIn.listen(() => {
          signInChangedCallback(gapi.auth2.getAuthInstance().isSignedIn.get());
        });
      });
  }

  /*
  * Initialize the client with API key and People API, and initialize OAuth with an
  * OAuth 2.0 client ID and scopes (space delimited string) to request access.
  */
  private static _initClient(): Promise<void> {
    return gapi.auth2.init({
      client_id: GapiManager._clientId,
      fetch_basic_profile: true,
      scope: initialScopeString,
    })
    // .init does not return a catch-able promise
    .then(() => null, (errorReason: any) => {
      throw new Error('Error in gapi auth: ' + errorReason.details);
    });
  }

  /**
   * Loads the oauth2 client id. Looks first in the user settings,
   * then in the config-local file.
   */
  private static _loadClientId(): Promise<void> {
    return GapiManager._loadClientIdFromUserSettings()
      .then((clientId) => clientId || GapiManager._loadClientIdFromConfigFile())
      .then((clientId) => {
        if (!clientId) {
          throw new MissingClientIdError();
        }
        GapiManager._clientId = clientId;
      });
  }

  /**
   * Loads the oauth2 client id from the user settings.
   */
  private static _loadClientIdFromUserSettings(): Promise<string> {
    return SettingsManager.getUserSettingsAsync()
      .then((settings: common.UserSettings) => {
        return settings.oauth2ClientId;
      })
      .catch(() => {
        return '';
      });
  }

  /**
   * Loads the oauth2 client id from the config-local file.
   */
  private static _loadClientIdFromConfigFile(): Promise<string> {
    return SettingsManager.loadConfigToWindowDatalab()
      .catch()  // We will detect errors below when we see if the clientId exists
      .then(() => {
        if (window.datalab && window.datalab.oauth2ClientId) {
          return window.datalab.oauth2ClientId;
        } else {
          return '';
        }
      });
  }

  private static _getScopeString(scope: GapiScopes): string {
    switch (scope) {
      case GapiScopes.BIGQUERY:
        return 'https://www.googleapis.com/auth/bigquery';
      case GapiScopes.DRIVE:
        return ['https://www.googleapis.com/auth/drive',
                'https://www.googleapis.com/auth/drive.appfolder',
                'https://www.googleapis.com/auth/drive.readonly.metadata',
                'https://www.googleapis.com/auth/drive.install',
                'https://www.googleapis.com/auth/drive.file'].join(' ');
      case GapiScopes.GCS:
          return 'https://www.googleapis.com/auth/devstorage.full_control';
      default:
        throw new Error('Unknown gapi scope: ' + scope);
    }
  }
}
