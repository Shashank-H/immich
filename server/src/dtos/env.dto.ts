import { ImmichEnvironmentSchema, LogFormatSchema, LogLevelSchema } from 'src/enum';
import { IsIPRange } from 'src/validation';
import z from 'zod';

// TODO import from sql-tools once the swagger plugin supports external enums
enum DatabaseSslMode {
  Disable = 'disable',
  Allow = 'allow',
  Prefer = 'prefer',
  Require = 'require',
  VerifyFull = 'verify-full',
}

const DatabaseSslModeSchema = z.enum(DatabaseSslMode).describe('Database SSL mode').meta({ id: 'DatabaseSslMode' });
const absolutePath = z.string().regex(/^\//, 'Must be an absolute path').optional();
/**
 * Treat certain strings as booleans and coerce them to boolean
 * Ideal for environment variables that are strings but should be treated as booleans
 * @docs https://zod.dev/api?id=stringbool
 */
const stringBool = z.stringbool();
const secret = z.string().min(1).meta({ secret: true });
const s3Prefix = z
  .string()
  .trim()
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\/\/)[^\\]*?(?<!\/$)/,
    'Must be a relative key prefix without empty, dot, or parent segments',
  )
  .optional();

const trustedProxiesSchema = z
  .string()
  .optional()
  .transform((s) =>
    s
      ? s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined,
  )

  .pipe(z.union([z.undefined(), IsIPRange({ requireCIDR: false })]));

export const EnvSchema = z
  .object({
    IMMICH_API_METRICS_PORT: z.coerce.number().int().optional(),
    IMMICH_BUILD_DATA: z.string().optional(),
    IMMICH_BUILD: z.string().optional(),
    IMMICH_BUILD_URL: z.string().optional(),
    IMMICH_BUILD_IMAGE: z.string().optional(),
    IMMICH_BUILD_IMAGE_URL: z.string().optional(),
    IMMICH_CONFIG_FILE: z.string().optional(),
    IMMICH_HELMET_FILE: z.string().optional(),
    IMMICH_ENV: ImmichEnvironmentSchema.optional(),
    IMMICH_HOST: z.string().optional(),
    IMMICH_IGNORE_MOUNT_CHECK_ERRORS: stringBool.optional(),
    IMMICH_LOG_LEVEL: LogLevelSchema.optional(),
    IMMICH_LOG_FORMAT: LogFormatSchema.optional(),
    IMMICH_MEDIA_LOCATION: absolutePath,
    IMMICH_MEDIA_BACKEND: z.enum(['filesystem', 's3']).optional(),
    IMMICH_S3_BUCKET: z.string().trim().min(1).optional(),
    IMMICH_S3_REGION: z.string().trim().min(1).optional(),
    IMMICH_S3_ENDPOINT: z.url().optional(),
    IMMICH_S3_KEY_PREFIX: s3Prefix,
    IMMICH_S3_ACCESS_KEY_ID: secret.optional(),
    IMMICH_S3_SECRET_ACCESS_KEY: secret.optional(),
    IMMICH_S3_SESSION_TOKEN: secret.optional(),
    IMMICH_S3_USE_DEFAULT_CREDENTIALS: stringBool.optional(),
    IMMICH_S3_FORCE_PATH_STYLE: stringBool.optional(),
    IMMICH_S3_TLS: stringBool.optional(),
    IMMICH_S3_SERVER_SIDE_ENCRYPTION: z.enum(['AES256', 'aws:kms']).optional(),
    IMMICH_S3_SSE_KMS_KEY_ID: z.string().trim().min(1).optional(),
    IMMICH_MICROSERVICES_METRICS_PORT: z.coerce.number().int().optional(),
    IMMICH_ALLOW_EXTERNAL_PLUGINS: stringBool.optional(),
    IMMICH_PLUGINS_INSTALL_FOLDER: absolutePath,
    IMMICH_PORT: z.coerce.number().int().optional(),
    IMMICH_REPOSITORY: z.string().optional(),
    IMMICH_REPOSITORY_URL: z.string().optional(),
    IMMICH_SOURCE_REF: z.string().optional(),
    IMMICH_SOURCE_COMMIT: z.string().optional(),
    IMMICH_SOURCE_URL: z.string().optional(),
    IMMICH_TELEMETRY_INCLUDE: z.string().optional(),
    IMMICH_TELEMETRY_EXCLUDE: z.string().optional(),
    IMMICH_THIRD_PARTY_SOURCE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_BUG_FEATURE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_DOCUMENTATION_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_SUPPORT_URL: z.string().optional(),
    IMMICH_ALLOW_SETUP: stringBool.optional(),
    IMMICH_TRUSTED_PROXIES: trustedProxiesSchema,
    IMMICH_WORKERS_INCLUDE: z.string().optional(),
    IMMICH_WORKERS_EXCLUDE: z.string().optional(),
    DB_DATABASE_NAME: z.string().optional(),
    DB_HOSTNAME: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_PORT: z.coerce.number().int().optional(),
    DB_SKIP_MIGRATIONS: stringBool.optional(),
    DB_SSL_MODE: DatabaseSslModeSchema.optional(),
    DB_URL: z.string().optional(),
    DB_USERNAME: z.string().optional(),
    DB_VECTOR_EXTENSION: z.enum(['pgvector', 'vectorchord']).optional(),
    NO_COLOR: z.string().optional(),
    REDIS_HOSTNAME: z.string().optional(),
    REDIS_PORT: z.coerce.number().int().optional(),
    REDIS_DBINDEX: z.coerce.number().int().optional(),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_SOCKET: z.string().optional(),
    REDIS_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.IMMICH_MEDIA_BACKEND !== 's3') {
      return;
    }
    if (!env.IMMICH_S3_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['IMMICH_S3_BUCKET'], message: 'Required when IMMICH_MEDIA_BACKEND=s3' });
    }
    const hasAccessKey = !!env.IMMICH_S3_ACCESS_KEY_ID;
    const hasSecretKey = !!env.IMMICH_S3_SECRET_ACCESS_KEY;
    if (hasAccessKey !== hasSecretKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMICH_S3_ACCESS_KEY_ID'],
        message: 'Access key ID and secret access key must be provided together',
      });
    }
    if (env.IMMICH_S3_SESSION_TOKEN && !hasAccessKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMICH_S3_SESSION_TOKEN'],
        message: 'A session token requires static access key credentials',
      });
    }
    if (env.IMMICH_S3_USE_DEFAULT_CREDENTIALS === true && hasAccessKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMICH_S3_USE_DEFAULT_CREDENTIALS'],
        message: 'Default credential chain cannot be combined with static credentials',
      });
    }
    if (env.IMMICH_S3_USE_DEFAULT_CREDENTIALS === false && !hasAccessKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMICH_S3_ACCESS_KEY_ID'],
        message: 'Static credentials are required when the default credential chain is disabled',
      });
    }
    if (env.IMMICH_S3_ENDPOINT) {
      const endpoint = new URL(env.IMMICH_S3_ENDPOINT);
      const protocol = endpoint.protocol;
      const tls = env.IMMICH_S3_TLS ?? true;
      if ((tls && protocol !== 'https:') || (!tls && protocol !== 'http:')) {
        ctx.addIssue({
          code: 'custom',
          path: ['IMMICH_S3_ENDPOINT'],
          message: `Endpoint protocol must be ${tls ? 'https' : 'http'} when IMMICH_S3_TLS=${tls}`,
        });
      }
      if (endpoint.username || endpoint.password) {
        ctx.addIssue({
          code: 'custom',
          path: ['IMMICH_S3_ENDPOINT'],
          message: 'Endpoint URL must not contain credentials',
        });
      }
    } else if (env.IMMICH_S3_TLS === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMICH_S3_TLS'],
        message: 'TLS can only be disabled for a custom endpoint',
      });
    }
    if (env.IMMICH_S3_SSE_KMS_KEY_ID && env.IMMICH_S3_SERVER_SIDE_ENCRYPTION !== 'aws:kms') {
      ctx.addIssue({
        code: 'custom',
        path: ['IMMICH_S3_SSE_KMS_KEY_ID'],
        message: 'A KMS key requires IMMICH_S3_SERVER_SIDE_ENCRYPTION=aws:kms',
      });
    }
  })
  .meta({ id: 'EnvDto' });
