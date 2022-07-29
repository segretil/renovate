import { DescribePullThroughCacheRulesCommand } from '@aws-sdk/client-ecr';
import is from '@sindresorhus/is';
import type { StrNodeChildMatcher } from 'good-enough-parser/dist/cjs/query/matchers/str-matcher';
import { load } from 'js-yaml';
import { logger } from '../../../logger';
import { cache } from '../../../util/cache/package/decorator';
import { GithubHttp } from '../../../util/http/github';
import { ensureTrailingSlash, joinUrlParts } from '../../../util/url';
import { Datasource } from '../datasource';
import type { GetReleasesConfig, Release, ReleaseResult } from '../types';
import { conanDatasourceRegex, datasource, defaultRegistryUrl } from './common';
import type { ConanJSON, ConanYAML, ConanRevisionsJSON } from './types';

function getRevision(packageName: string): string | undefined {
  const splitted = packageName.split('#');
  if (splitted.length <= 1) {
    return undefined;
  } else {
    return splitted[1];
  }
}

export class ConanDatasource extends Datasource {
  static readonly id = datasource;

  override readonly defaultRegistryUrls = [defaultRegistryUrl];

  override readonly caching = true;

  override readonly registryStrategy = 'merge';

  githubHttp: GithubHttp;

  constructor(id = ConanDatasource.id) {
    super(id);
    this.githubHttp = new GithubHttp(id);
  }

  async getConanCenterReleases(
    depName: string,
    userAndChannel: string
  ): Promise<ReleaseResult | null> {
    if (userAndChannel && userAndChannel !== '@_/_') {
      logger.debug(
        { depName, userAndChannel },
        'User/channel not supported for Conan Center lookups'
      );
      return null;
    }
    const url = `https://api.github.com/repos/conan-io/conan-center-index/contents/recipes/${depName}/config.yml`;
    const res = await this.githubHttp.get(url, {
      headers: { accept: 'application/vnd.github.v3.raw' },
    });
    const doc = load(res.body, {
      json: true,
    }) as ConanYAML;
    const newDigest = '423';
    return {
      releases: Object.keys(doc?.versions ?? {}).map((version) => ({
        version,
        newDigest,
      })),
    };
  }

  async getNewDigest(
    url: string,
    packageName: string
  ): Promise<string | undefined> {
    const revisionLookUp = joinUrlParts(
      url,
      `v2/conans/${packageName}/revisions`
    );
    const revisionRep = await this.http.getJson<ConanRevisionsJSON>(
      revisionLookUp
    );
    const revisions = revisionRep?.body.revisions;
    if (revisions) {
      return revisions[0].revision;
    }
  }

  @cache({
    namespace: `datasource-${datasource}`,
    key: ({ registryUrl, packageName }: GetReleasesConfig) =>
      `${registryUrl}:${packageName}`,
  })
  async getReleases({
    registryUrl,
    packageName,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    // debugger;
    const depName = packageName.split('/')[0];
    const userAndChannel = '@' + packageName.split('@')[1].split('#')[0];
    // TODO: check undefined
    const revision = getRevision(packageName);
    if (
      is.string(registryUrl) &&
      ensureTrailingSlash(registryUrl) === defaultRegistryUrl &&
      is.undefined(revision)
    ) {
      return this.getConanCenterReleases(depName, userAndChannel);
    }

    logger.trace({ depName, registryUrl }, 'Looking up conan api dependency');
    if (registryUrl) {
      const url = ensureTrailingSlash(registryUrl);
      const lookupUrl = joinUrlParts(url, `v2/conans/search?q=${depName}`);

      try {
        const rep = await this.http.getJson<ConanJSON>(lookupUrl);
        // debugger;
        const versions = rep?.body;
        if (versions) {
          logger.trace({ lookupUrl }, 'Got conan api result');
          const dep: ReleaseResult = { releases: [] };

          for (const resultString of Object.values(versions.results ?? {})) {
            const fromMatch = conanDatasourceRegex.exec(resultString);
            if (fromMatch?.groups?.version && fromMatch?.groups?.userChannel) {
              const version = fromMatch.groups.version;
              if (fromMatch.groups.userChannel === userAndChannel) {
                let newDigest: string | undefined = undefined;
                if (revision) {
                  const packageNameWithoutRevision = `${depName}/${version}${userAndChannel.replace(
                    '@',
                    '/'
                  )}`;
                  newDigest = await this.getNewDigest(
                    url,
                    packageNameWithoutRevision
                  );
                }
                const result: Release = {
                  version,
                  newDigest,
                };
                dep.releases.push(result);
              }
            }
          }
          return dep;
        }
      } catch (err) {
        this.handleGenericErrors(err);
      }
    }

    return null;
  }
}
