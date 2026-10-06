import moment from 'moment';

import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { subscriptionResolvers } from '../../graphql/resolvers/subscription.resolver';
import {
  BadRequestError,
  ForbiddenError,
  BAD_REQUEST_ERRORS,
} from '../../utils/errors.util';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests del seam SubscriptionService.adjustSessionCredits — issue #112.
 *
 * Ajuste manual auditado de créditos de un Session Pack. Prior art:
 * subscription.cancellation.test.ts (EM + procesador de pago mockeados, AAA;
 * aserciones sobre la ServiceResponse, el error lanzado y el estado resultante).
 */
describe('SubscriptionService — adjustSessionCredits', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let subscription: any;

  function buildSubscription(overrides: Record<string, any> = {}) {
    return {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      company: 'comp-1',
      currentPeriodEnd: moment().add(15, 'days').toDate(),
      creditsTotal: 4,
      creditsUsed: 1,
      metadata: {},
      plan: { id: 'plan-pack', name: 'Bono 4', sessionCount: 4 },
      user: { id: 'user-1' },
      ...overrides,
    };
  }

  beforeEach(() => {
    subscription = buildSubscription();

    mockEm = {
      findOne: jest.fn(async (entity: any) =>
        entity === Subscription ? subscription : null
      ),
      flush: jest.fn(async () => {}),
    };

    service = new SubscriptionService(mockEm as any, {} as any);
  });

  describe('happy path', () => {
    it('positive delta raises creditsTotal and records credit_adjusted with delta, reason and actor', async () => {
      const response = await service.adjustSessionCredits(
        { subscriptionId: 'sub-1', delta: 2, reason: 'gift' },
        'admin-9'
      );

      expect(response.success).toBe(true);
      expect(subscription.creditsTotal).toBe(6);
      expect(subscription.creditsUsed).toBe(1);
      expect(mockEm.flush).toHaveBeenCalledTimes(1);

      const history = subscription.metadata.history;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        event: 'credit_adjusted',
        actor: 'admin-9',
        delta: 2,
        reason: 'gift',
      });
      expect(history[0].detail).toContain('+2');
      expect(history[0].detail).toContain('gift');
    });

    it('negative delta lowers creditsTotal down to exactly creditsUsed', async () => {
      subscription = buildSubscription({ creditsTotal: 4, creditsUsed: 2 });

      const response = await service.adjustSessionCredits(
        { subscriptionId: 'sub-1', delta: -2, reason: 'fix' },
        'admin-9'
      );

      expect(response.success).toBe(true);
      expect(subscription.creditsTotal).toBe(2);
      expect(subscription.metadata.history[0]).toMatchObject({
        event: 'credit_adjusted',
        delta: -2,
      });
    });

    it('returns the subscription in the response', async () => {
      const response: any = await service.adjustSessionCredits(
        { subscriptionId: 'sub-1', delta: 1, reason: 'gift' },
        'admin-9'
      );

      expect(response.subscription).toBe(subscription);
    });
  });

  describe('input validation', () => {
    it.each(['', '   '])('rejects reason %j', async reason => {
      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: 1, reason },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.REASON_REQUIRED);
      expect(subscription.creditsTotal).toBe(4);
      expect(mockEm.flush).not.toHaveBeenCalled();
    });

    it('rejects delta = 0', async () => {
      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: 0, reason: 'noop' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_DELTA_INVALID);
      expect(mockEm.flush).not.toHaveBeenCalled();
    });

    it('rejects a non-integer delta', async () => {
      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: 1.5, reason: 'half' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_DELTA_INVALID);
    });

    it('rejects a missing subscriptionId', async () => {
      await expect(
        service.adjustSessionCredits(
          { subscriptionId: '', delta: 1, reason: 'x' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.SUBSCRIPTION_ID_REQUIRED);
    });
  });

  describe('bounds', () => {
    it('rejects when the result would leave creditsUsed > creditsTotal', async () => {
      subscription = buildSubscription({ creditsTotal: 4, creditsUsed: 3 });

      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: -2, reason: 'too much' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_ADJUSTMENT_OUT_OF_BOUNDS);
      expect(subscription.creditsTotal).toBe(4);
      expect(subscription.metadata.history).toBeUndefined();
      expect(mockEm.flush).not.toHaveBeenCalled();
    });

    it('rejects when the result would leave creditsTotal < 0', async () => {
      subscription = buildSubscription({ creditsTotal: 0, creditsUsed: 0 });

      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: -1, reason: 'negative' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_ADJUSTMENT_OUT_OF_BOUNDS);
      expect(subscription.creditsTotal).toBe(0);
    });
  });

  describe('subscription state', () => {
    it.each([null, undefined])(
      'rejects an unlimited subscription (creditsTotal = %s)',
      async creditsTotal => {
        subscription = buildSubscription({ creditsTotal });

        await expect(
          service.adjustSessionCredits(
            { subscriptionId: 'sub-1', delta: 1, reason: 'x' },
            'admin-9'
          )
        ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_ADJUSTMENT_UNLIMITED);
        expect(mockEm.flush).not.toHaveBeenCalled();
      }
    );

    it('rejects a CANCELED subscription', async () => {
      subscription = buildSubscription({
        status: SubscriptionStatus.CANCELED,
        currentPeriodEnd: moment().subtract(1, 'day').toDate(),
      });

      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: 1, reason: 'x' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_ADJUSTMENT_CLOSED);
    });

    it('rejects a subscription whose period has already elapsed', async () => {
      subscription = buildSubscription({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: moment().subtract(1, 'minute').toDate(),
      });

      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: 1, reason: 'x' },
          'admin-9'
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.CREDIT_ADJUSTMENT_CLOSED);
    });

    it('throws NotFound when the subscription does not exist', async () => {
      mockEm.findOne = jest.fn(async () => null);

      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'missing', delta: 1, reason: 'x' },
          'admin-9'
        )
      ).rejects.toThrow(/Subscription/);
    });

    it('rejects a subscription from another company', async () => {
      await expect(
        service.adjustSessionCredits(
          { subscriptionId: 'sub-1', delta: 1, reason: 'x' },
          'admin-9',
          'comp-other'
        )
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('resolver permission gate', () => {
    it('rejects a caller without plansPermissions.CREATE_UPDATE_DELETE', async () => {
      const context: any = {
        currentUser: { id: 'user-1', permissionNames: [] },
      };

      await expect(
        (subscriptionResolvers.Mutation as any).adjustSessionCredits(
          {},
          { subscriptionId: 'sub-1', delta: 1, reason: 'x' },
          context,
          {}
        )
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('BadRequestError is used for validation failures', async () => {
    await expect(
      service.adjustSessionCredits(
        { subscriptionId: 'sub-1', delta: 0, reason: 'x' },
        'admin-9'
      )
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
