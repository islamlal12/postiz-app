import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import dayjs from 'dayjs';
import {
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';

const instagramProvider = new InstagramProvider();

@Rules(
  "Instagram should have at least one attachment, if it's a story, it can have only one picture"
)
export class InstagramStandaloneProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'instagram-standalone';
  name = 'Instagram\n(Standalone)';
  isBetweenSteps = false;
  refreshCron = true;
  scopes = [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_insights',
  ];
    override maxConcurrentJob = 200; // Instagram standalone has stricter limits
  dto = InstagramDto;

  editor = 'normal' as const;
  maxLength() {
    return 2200;
  }

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (!firstPost?.length) {
      return 'Should have at least one media';
    }
    if (this.assetBoolean(settings?.is_trial_reel)) {
      if ((firstPost?.length ?? 0) > 1) {
        return 'Trial Reels can only have one video';
      }
      const hasVideo = firstPost?.some(
        (f) => (f?.path?.indexOf?.('mp4') ?? -1) > -1
      );
      if (!hasVideo) {
        return 'Trial Reels must be a video';
      }
    }
    return true;
  }

  public override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    return instagramProvider.handleErrors(body, status);
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    const { access_token } = await (
      await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${refresh_token}`
      )
    ).json();

    const {
      id: user_id,
      name,
      username,
      profile_picture_url = '',
    } = await (
      await fetch(
        `https://graph.instagram.com/${META_GRAPH_API_VERSION}/me?fields=id,username,name,profile_picture_url&access_token=${access_token}`
      )
    ).json();

    return {
      id: user_id,
      name: name || username || 'Instagram',
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: profile_picture_url || '',
      username,
    };
  }

  private getRedirectUri(): string {
    const frontendUrl = process?.env.FRONTEND_URL || '';
    const domain = frontendUrl.indexOf('https') === -1
      ? `https://redirectmeto.com/${frontendUrl}`
      : frontendUrl;
    return `${domain.replace(/\/+$/, '')}/integrations/social/instagram-standalone`;
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    const redirectUri = this.getRedirectUri();
    return {
      url:
        `https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=${
          process.env.INSTAGRAM_APP_ID
        }&redirect_uri=${encodeURIComponent(
          redirectUri
        )}&response_type=code&scope=${encodeURIComponent(
          this.scopes.join(',')
        )}` + `&state=${state}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh: string;
  }) {
    const cleanCode = String(params.code || '').replace(/#.*$/, '').trim();
    const redirectUri = this.getRedirectUri();

    const formData = new FormData();
    formData.append('client_id', process.env.INSTAGRAM_APP_ID!);
    formData.append('client_secret', process.env.INSTAGRAM_APP_SECRET!);
    formData.append('grant_type', 'authorization_code');
    formData.append('redirect_uri', redirectUri);
    formData.append('code', cleanCode);

    const getAccessToken = await (
      await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body: formData,
      })
    ).json();

    if (
      getAccessToken?.error_type === 'OAuthException' ||
      getAccessToken?.error_message ||
      getAccessToken?.error
    ) {
      const errMsg =
        getAccessToken.error_message ||
        getAccessToken.error?.message ||
        'Instagram token exchange failed';
      console.error('IG_TOKEN_EXCHANGE_FAILED:', errMsg);
      return errMsg;
    }

    let finalAccessToken = getAccessToken.access_token;
    let tokenExpiresIn = getAccessToken.expires_in || 3600;

    try {
      const longLived = await (
        await fetch(
          'https://graph.instagram.com/access_token' +
            '?grant_type=ig_exchange_token' +
            `&client_id=${process.env.INSTAGRAM_APP_ID}` +
            `&client_secret=${process.env.INSTAGRAM_APP_SECRET}` +
            `&access_token=${getAccessToken.access_token}`
        )
      ).json();
      if (longLived.access_token) {
        finalAccessToken = longLived.access_token;
        tokenExpiresIn =
          longLived.expires_in ||
          dayjs().add(58, 'days').unix() - dayjs().unix();
      }
    } catch (e) {
      console.error('IG_LONGLIVED_ERR:', e);
    }

    if (getAccessToken.permissions) {
      this.checkScopes(this.scopes, getAccessToken.permissions);
    }

    const me = await (
      await fetch(
        `https://graph.instagram.com/${META_GRAPH_API_VERSION}/me?fields=id,username,name,profile_picture_url&access_token=${finalAccessToken}`
      )
    ).json();

    if (me?.error) {
      const errMsg = me.error.message || 'Failed to retrieve Instagram profile';
      console.error('IG_ME_ERROR:', errMsg);
      return errMsg;
    }

    const finalId = String(me?.id || me?.user_id || getAccessToken?.user_id || '');
    if (!finalId) {
      return 'Instagram user ID not found in profile';
    }

    const finalUsername = me?.username || 'instagram';
    const finalName = me?.name || finalUsername;
    const finalPicture = me?.profile_picture_url || '';

    return {
      id: finalId,
      name: finalName,
      accessToken: finalAccessToken,
      refreshToken: finalAccessToken,
      expiresIn: tokenExpiresIn,
      picture: finalPicture,
      username: finalUsername,
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.post(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.postPending(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  // the graph domain travels inside pendingData, so these are pure delegations
  override async checkPostStatus(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.checkPostStatus(
      accessToken,
      pendingData,
      integration
    );
  }

  override async finalizePost(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.finalizePost(accessToken, pendingData, integration);
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.comment(
      id,
      postId,
      lastCommentId,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  async analytics(id: string, accessToken: string, date: number) {
    return instagramProvider.analytics(
      id,
      accessToken,
      date,
      'graph.instagram.com'
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ) {
    return instagramProvider.postAnalytics(
      integrationId,
      accessToken,
      postId,
      date,
      'graph.instagram.com'
    );
  }
}
