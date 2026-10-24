import { Router, Request, Response, NextFunction } from 'express';
import { createResponse } from '../../utils/responses.js';
import {
  APIError,
  constants,
  createLogger,
  formatZodError,
  segmentsEnabled,
  segmentsFor,
} from '@aiostreams/core';
import { ZodError } from 'zod';
import { segmentsApiRateLimiter } from '../../middlewares/ratelimit.js';
import {
  lookupOf,
  SegmentsQuerySchema,
  type SegmentsQuery,
} from './segments-query.js';

const router: Router = Router();
const logger = createLogger('server');

router.use(segmentsApiRateLimiter);

const TYPE_NAMES = { Intro: 'intro', Recap: 'recap', Outro: 'outro' } as const;

const seconds = (ms: number) => Math.round(ms) / 1000;

/**
 * Intro, recap and credits markers for an episode or a movie, in seconds, from
 * the same providers, cache and selection as Jellyfin's MediaSegments, but
 * keyed by plain ids and without signing in. Without season and episode it is
 * a movie.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  let query: SegmentsQuery;
  try {
    query = SegmentsQuerySchema.parse(req.query);
  } catch (error: any) {
    next(
      error instanceof ZodError
        ? new APIError(
            constants.ErrorCode.BAD_REQUEST,
            400,
            formatZodError(error)
          )
        : new APIError(constants.ErrorCode.BAD_REQUEST, 400, error.message)
    );
    return;
  }

  const lookup = lookupOf(query);

  try {
    const segments = segmentsEnabled() ? await segmentsFor(lookup) : [];
    res.status(200).json(
      createResponse({
        success: true,
        detail: 'OK',
        data: {
          segments: segments.map((s) => ({
            type: TYPE_NAMES[s.type],
            start: seconds(s.startMs),
            end: seconds(s.endMs),
            provider: s.provider,
            matchesFile: !!s.matchesFile,
          })),
        },
      })
    );
  } catch (error: any) {
    logger.error(`Segments lookup failed: ${error.message}`);
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        error.message
      )
    );
  }
});

export default router;
