import moment from 'moment';

import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { subscriptionResolvers } from '../../graphql/resolvers/subscription.resolver';
import {
  BAD_REQUEST_ERRORS,
  CONFLICT_ERRORS,
  ForbiddenError,
  UnauthorizedError,
} from '../../utils/errors.util';
import { SubscriptionService } from '../subscription.service';

const mockSendToUser = jest.fn(async (..._args: any[]) => {});

jest.mock('../notification.service', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({
    sendToUsers: jest.fn(async () => {}),
    sendToUser: mockSendToUser,
  })),
}));

/**
 * Cancelación de suscripciones por un administrador (Deferred Cancellation,
 * Radical Cancellation, Undo Cancellation en CONTEXT-MAP.md).
 *
 * Prior art: subscription.cancellation.test.ts — EntityManager mockeado y
 * aserciones sobre la respuesta y el estado de la entidad. NotificationService
 * se mockea como puerto de salida, igual que en schedule.gym-cancel-refund.
 */
describe('Subscription cancellation by an administrator', () => {
  let mockEm: any;
  let subscription: any;

  function buildSubscription(overrides: Record<string, any> = {}) {
    const periodEnd = moment().add(15, 'days').toDate();
    return {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      isActive: true,
      company: 'comp-1',
      currentPeriodStart: moment().subtract(15, 'days').toDate(),
      currentPeriodEnd: periodEnd,
      nextBillingDate: periodEnd,
      cancelAtPeriodEnd: false,
      metadata: {},
      plan: { id: 'plan-1', name: 'Premium', amount: 5000 },
      user: { id: 'member-1' },
      ...overrides,
    };
  }

  function contextFor(userId: string, permissionNames: string[] = []): any {
    return {
      em: mockEm,
      paymentProcessor: {},
      currentUser: { id: userId, activeCompanyId: 'comp-1', permissionNames },
    };
  }

  const Mutation = subscriptionResolvers.Mutation as any;

  beforeEach(() => {
    mockSendToUser.mockReset();
    mockSendToUser.mockImplementation(async () => {});
    subscription = buildSubscription();
    mockEm = {
      findOne: jest.fn(async (entity: any) =>
        entity === Subscription ? subscription : null
      ),
      find: jest.fn(async () => []),
      flush: jest.fn(async () => {}),
    };
  });

  describe('cancelSubscription — who may cancel', () => {
    it('lets a member cancel their own subscription', async () => {
      const response = await Mutation.cancelSubscription(
        {},
        { input: { subscriptionId: 'sub-1' } },
        contextFor('member-1')
      );

      expect(response.success).toBe(true);
      expect(subscription.cancelAtPeriodEnd).toBe(true);
    });

    it("refuses a member cancelling someone else's subscription", async () => {
      await expect(
        Mutation.cancelSubscription(
          {},
          { input: { subscriptionId: 'sub-1' } },
          contextFor('member-2')
        )
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(subscription.cancelAtPeriodEnd).toBe(false);
    });

    it('refuses an unauthenticated caller', async () => {
      await expect(
        Mutation.cancelSubscription(
          {},
          { input: { subscriptionId: 'sub-1' } },
          { em: mockEm, paymentProcessor: {}, currentUser: null }
        )
      ).rejects.toBeInstanceOf(UnauthorizedError);

      expect(subscription.cancelAtPeriodEnd).toBe(false);
    });

    it("lets an administrator cancel a member's subscription", async () => {
      const response = await Mutation.cancelSubscription(
        {},
        { input: { subscriptionId: 'sub-1' } },
        contextFor('admin-1', ['plans:manage'])
      );

      expect(response.success).toBe(true);
      expect(subscription.cancelAtPeriodEnd).toBe(true);
    });
  });
  describe('radicalCancelSubscription — only on a live subscription', () => {
    const radicalCancel = () =>
      new SubscriptionService(mockEm, {} as any).radicalCancelSubscription(
        { subscriptionId: 'sub-1', reason: 'fraud' },
        'admin-1'
      );

    it('refuses a subscription that is already CANCELED, keeping when it ended', async () => {
      const endedAt = moment().subtract(10, 'days').toDate();
      subscription = buildSubscription({
        status: SubscriptionStatus.CANCELED,
        isActive: false,
        canceledAt: endedAt,
        endedAt,
        currentPeriodEnd: endedAt,
      });

      await expect(radicalCancel()).rejects.toThrow(
        BAD_REQUEST_ERRORS.SUBSCRIPTION_ALREADY_CLOSED
      );
      expect(subscription.endedAt).toBe(endedAt);
      expect(subscription.currentPeriodEnd).toBe(endedAt);
    });

    it('refuses a subscription whose period has already elapsed', async () => {
      const periodEnd = moment().subtract(1, 'day').toDate();
      subscription = buildSubscription({ currentPeriodEnd: periodEnd });

      await expect(radicalCancel()).rejects.toThrow(
        BAD_REQUEST_ERRORS.SUBSCRIPTION_ALREADY_CLOSED
      );
      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('annuls a Future Subscription that has not started yet', async () => {
      subscription = buildSubscription({
        currentPeriodStart: moment().add(10, 'days').toDate(),
        currentPeriodEnd: moment().add(40, 'days').toDate(),
      });

      const response = await radicalCancel();

      expect(response.success).toBe(true);
      expect(subscription.status).toBe(SubscriptionStatus.CANCELED);
    });
  });
  describe('undoCancellation — withdrawing a deferred cancellation', () => {
    const undo = () =>
      new SubscriptionService(mockEm, {} as any).undoCancellation(
        'sub-1',
        'admin-1'
      );

    it('makes the subscription renew again and records who undid it', async () => {
      subscription = buildSubscription({ cancelAtPeriodEnd: true });

      const response = await undo();

      expect(response.success).toBe(true);
      expect(subscription.cancelAtPeriodEnd).toBe(false);
      const entry = (subscription.metadata.history as any[]).find(
        h => h.event === 'cancel_undone'
      );
      expect(entry.actor).toBe('admin-1');
    });

    it('refuses when no cancellation is scheduled', async () => {
      await expect(undo()).rejects.toThrow(
        BAD_REQUEST_ERRORS.CANCELLATION_NOT_SCHEDULED
      );
    });

    it('refuses a subscription that is already closed', async () => {
      subscription = buildSubscription({
        cancelAtPeriodEnd: true,
        currentPeriodEnd: moment().subtract(1, 'day').toDate(),
      });

      await expect(undo()).rejects.toThrow(
        BAD_REQUEST_ERRORS.SUBSCRIPTION_ALREADY_CLOSED
      );
      expect(subscription.cancelAtPeriodEnd).toBe(true);
    });

    it('refuses while a Future Subscription to the same plan is scheduled', async () => {
      subscription = buildSubscription({ cancelAtPeriodEnd: true });
      const future = buildSubscription({
        id: 'sub-future',
        currentPeriodStart: moment().add(16, 'days').toDate(),
        currentPeriodEnd: moment().add(46, 'days').toDate(),
      });
      mockEm.find = jest.fn(async () => [future]);

      await expect(undo()).rejects.toThrow(
        CONFLICT_ERRORS.FUTURE_SUBSCRIPTION_BLOCKS_UNDO
      );
      expect(subscription.cancelAtPeriodEnd).toBe(true);
    });

    it('is gated to administrators at the resolver', async () => {
      subscription = buildSubscription({ cancelAtPeriodEnd: true });

      await expect(
        Mutation.undoSubscriptionCancellation(
          {},
          { subscriptionId: 'sub-1' },
          contextFor('member-1')
        )
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(subscription.cancelAtPeriodEnd).toBe(true);
    });
  });
  describe('the member is told when someone else cancels', () => {
    const notifiedUserIds = () => mockSendToUser.mock.calls.map(c => c[0]);

    it('notifies the member when an administrator defers the cancellation', async () => {
      await Mutation.cancelSubscription(
        {},
        { input: { subscriptionId: 'sub-1' } },
        contextFor('admin-1', ['plans:manage'])
      );

      expect(notifiedUserIds()).toEqual(['member-1']);
    });

    it('does not notify a member who cancels their own subscription', async () => {
      await Mutation.cancelSubscription(
        {},
        { input: { subscriptionId: 'sub-1' } },
        contextFor('member-1')
      );

      expect(mockSendToUser).not.toHaveBeenCalled();
    });

    it('notifies the member of a radical cancellation', async () => {
      await new SubscriptionService(
        mockEm,
        {} as any
      ).radicalCancelSubscription(
        { subscriptionId: 'sub-1', reason: 'fraud' },
        'admin-1'
      );

      expect(notifiedUserIds()).toEqual(['member-1']);
    });

    it('notifies the member when the cancellation is undone', async () => {
      subscription = buildSubscription({ cancelAtPeriodEnd: true });

      await new SubscriptionService(mockEm, {} as any).undoCancellation(
        'sub-1',
        'admin-1'
      );

      expect(notifiedUserIds()).toEqual(['member-1']);
    });

    it('still cancels when the notification fails', async () => {
      mockSendToUser.mockImplementation(async () => {
        throw new Error('push down');
      });

      const response = await new SubscriptionService(
        mockEm,
        {} as any
      ).radicalCancelSubscription(
        { subscriptionId: 'sub-1', reason: 'fraud' },
        'admin-1'
      );

      expect(response.success).toBe(true);
      expect(subscription.status).toBe(SubscriptionStatus.CANCELED);
    });
  });
});
