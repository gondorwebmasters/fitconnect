import moment from 'moment';

import { Plan, PlanInterval } from '../../entities/Plan';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import {
  BadRequestError,
  ConflictError,
  BAD_REQUEST_ERRORS,
  CONFLICT_ERRORS,
} from '../../utils/errors.util';
import { selectPayingSubscription } from '../entitlement.service';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests del seam SubscriptionService.createSubscription / changePlan para la
 * decisión 9 del ADR 0006: **comprar un plan añade**, nunca sustituye. Y para
 * la decisión 7: nunca dos vigentes al mismo plan, ni creando ni cambiando.
 *
 * Prior art: subscription.service.test.ts — EntityManager y procesador de pago
 * mockeados, aserciones sobre la ServiceResponse y sobre el estado de las
 * entidades, nunca sobre qué rama interna se eligió.
 */
describe('SubscriptionService — buying a Plan adds a Subscription', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let user: User;
  /** Suscripciones del usuario en comp-1, tal y como las vería la base. */
  let companySubs: any[];
  let planById: Record<string, any>;
  /** Plan que resuelve getActivePlanOrFail / el newPlanId de changePlan. */
  let requestedPlan: any;
  /** Suscripción que resuelve el findOne(Subscription, { id }) de changePlan. */
  let subscriptionById: any;

  const PREMIUM: any = {
    id: 'plan-premium',
    amount: 5000,
    interval: PlanInterval.MONTH,
    intervalCount: 1,
    currency: 'eur',
    name: 'Premium',
    trialPeriodDays: 0,
    isActive: true,
    sessionCount: null,
    company: { id: 'comp-1' },
  };

  const PACK: any = {
    id: 'plan-pack',
    amount: 9000,
    interval: PlanInterval.MONTH,
    intervalCount: 3,
    currency: 'eur',
    name: 'Entrenamientos personalizados',
    trialPeriodDays: 0,
    isActive: true,
    sessionCount: 10,
    company: { id: 'comp-1' },
  };

  const BASIC: any = {
    id: 'plan-basic',
    amount: 3000,
    interval: PlanInterval.MONTH,
    intervalCount: 1,
    currency: 'eur',
    name: 'Basic',
    trialPeriodDays: 0,
    isActive: true,
    sessionCount: null,
    company: { id: 'comp-1' },
  };

  /** Una suscripción vigente hoy al plan dado. */
  function liveSub(overrides: Record<string, any> = {}): any {
    return {
      id: `sub-${overrides.plan?.id ?? 'x'}`,
      user,
      company: 'comp-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: moment().subtract(10, 'days').toDate(),
      currentPeriodEnd: moment().add(20, 'days').toDate(),
      cancelAtPeriodEnd: true,
      isActive: true,
      metadata: {},
      ...overrides,
    };
  }

  function buildInput(overrides: Record<string, any> = {}) {
    return {
      userId: 'user-1',
      planId: requestedPlan.id,
      companyId: 'comp-1',
      ...overrides,
    };
  }

  /** El Entitlement tal y como lo lee EntitlementService: vigente hoy. */
  function liveNow(sub: any): boolean {
    const now = moment().toDate();
    return (
      [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING].includes(
        sub.status
      ) &&
      sub.currentPeriodStart <= now &&
      sub.currentPeriodEnd >= now
    );
  }

  /** Los eventos anotados en el historial de una suscripción. */
  function historyEvents(subscription: any): string[] {
    return ((subscription.metadata?.history ?? []) as any[]).map(h => h.event);
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    companySubs = [];
    planById = {
      [PREMIUM.id]: PREMIUM,
      [PACK.id]: PACK,
      [BASIC.id]: BASIC,
    };
    requestedPlan = PACK;
    subscriptionById = null;

    mockEm = {
      findOne: jest.fn((entity: any, where: any) => {
        if (entity === User) return user;
        if (entity === Plan) return planById[where.id] ?? null;
        if (entity === Subscription) return subscriptionById;
        return null;
      }),
      // Las dos consultas plurales que existen: el Entitlement vigente
      // (lleva rango de periodo) y las activas/futuras de la empresa.
      find: jest.fn(async (_entity: any, where: any) =>
        where.currentPeriodStart ? companySubs.filter(liveNow) : companySubs
      ),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn(),
      flush: jest.fn(async () => {}),
      refresh: jest.fn(async () => {}),
    };

    service = new SubscriptionService(mockEm as any, {} as any);
    (service as any).customerService.getOrCreateCustomer = jest
      .fn()
      .mockResolvedValue({ id: 'cust-1' });
    (service as any).getDefaultPaymentMethod = jest
      .fn()
      .mockResolvedValue(null);
    // El cobro tiene sus propios tests; aquí solo importa qué se crea.
    (service as any).attemptCharge = jest.fn(async () => {});
  });

  describe('createSubscription always adds', () => {
    it('creates a new subscription and leaves the live one on another plan untouched', async () => {
      const premium = liveSub({ plan: PREMIUM });
      companySubs = [premium];
      requestedPlan = PACK;

      const response = await service.createSubscription(buildInput());

      expect(response.code).toBe(201);
      const created = (response as any).subscription;
      expect(created.plan).toBe(PACK);
      // La vigente de Premium no se migra ni se toca.
      expect(premium.plan).toBe(PREMIUM);
      expect(
        (premium.metadata.history ?? []).some(
          (h: any) => h.event === 'plan_changed'
        )
      ).toBe(false);
    });

    it('lets a member hold a time-based plan and a Session Pack at the same time', async () => {
      const premium = liveSub({ plan: PREMIUM });
      companySubs = [premium];
      requestedPlan = PACK;

      const response = await service.createSubscription(buildInput());

      const created = (response as any).subscription;
      // Entidad nueva, con sus propios créditos y su propio ciclo.
      expect(created).not.toBe(premium);
      expect(created.creditsTotal).toBe(PACK.sessionCount);
      expect(created.creditsUsed).toBe(0);
      expect(created.failedPaymentAttempts).toBe(0);
      expect(mockEm.persist).toHaveBeenCalled();
    });

    it('creates a second time-based subscription too — no plan is special', async () => {
      companySubs = [liveSub({ plan: PREMIUM })];
      requestedPlan = BASIC;

      const response = await service.createSubscription(buildInput());

      expect(response.code).toBe(201);
      expect((response as any).subscription.plan).toBe(BASIC);
    });
  });

  describe('never two live subscriptions to the same plan', () => {
    it('refuses to create one for a plan the member is already live on', async () => {
      companySubs = [liveSub({ plan: PACK })];
      requestedPlan = PACK;

      await expect(service.createSubscription(buildInput())).rejects.toThrow(
        CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN
      );
    });

    it('throws a ConflictError, not a generic one', async () => {
      companySubs = [liveSub({ plan: PREMIUM })];
      requestedPlan = PREMIUM;

      await expect(
        service.createSubscription(buildInput())
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses to change plan onto a plan the member is already live on', async () => {
      const basic = liveSub({ plan: BASIC, id: 'sub-basic' });
      const premium = liveSub({ plan: PREMIUM, id: 'sub-premium' });
      companySubs = [basic, premium];
      subscriptionById = basic;

      await expect(
        service.changePlan({
          subscriptionId: 'sub-basic',
          newPlanId: PREMIUM.id,
        } as any)
      ).rejects.toThrow(CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN);
    });

    it('still changes plan when the member is not live on the target plan', async () => {
      const basic = liveSub({ plan: BASIC, id: 'sub-basic' });
      companySubs = [basic];
      subscriptionById = basic;

      const response = await service.changePlan({
        subscriptionId: 'sub-basic',
        newPlanId: PREMIUM.id,
      } as any);

      expect(response.code).toBe(200);
      expect(basic.plan).toBe(PREMIUM);
    });
  });

  describe('changePlan stays explicit', () => {
    it('still requires a subscription id', async () => {
      await expect(
        service.changePlan({ newPlanId: PREMIUM.id } as any)
      ).rejects.toThrow(BAD_REQUEST_ERRORS.SUB_AND_PLAN_REQUIRED);
    });

    it('still refuses to move into a Session Pack', async () => {
      const basic = liveSub({ plan: BASIC, id: 'sub-basic' });
      companySubs = [basic];
      subscriptionById = basic;

      await expect(
        service.changePlan({
          subscriptionId: 'sub-basic',
          newPlanId: PACK.id,
        } as any)
      ).rejects.toThrow(
        BAD_REQUEST_ERRORS.CANNOT_CHANGE_PLAN_WITH_SESSION_PACK
      );
    });

    it('still refuses to move out of a Session Pack', async () => {
      const pack = liveSub({ plan: PACK, id: 'sub-pack' });
      companySubs = [pack];
      subscriptionById = pack;

      await expect(
        service.changePlan({
          subscriptionId: 'sub-pack',
          newPlanId: BASIC.id,
        } as any)
      ).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe('chaining two identical packs stays a Future Subscription', () => {
    it('schedules the next pack after the live one and stops it renewing', async () => {
      const pack = liveSub({ plan: PACK, cancelAtPeriodEnd: false });
      companySubs = [pack];
      requestedPlan = PACK;
      // El plan del pack es de pago, pero encadenar exige fecha futura: se
      // usa un plan gratuito para no chocar con PAID_PLAN_MUST_START_TODAY.
      PACK.amount = 0;
      const start = moment(pack.currentPeriodEnd).add(1, 'day');

      const response = await service.createSubscription(
        buildInput({ startDate: start.toDate() })
      );

      PACK.amount = 9000;
      expect(response.code).toBe(201);
      const created = (response as any).subscription;
      expect(moment(created.currentPeriodStart).isSame(start, 'day')).toBe(
        true
      );
      // La vigente deja de renovar, pero conserva su plan y su periodo.
      expect(pack.cancelAtPeriodEnd).toBe(true);
      expect(pack.plan).toBe(PACK);
    });

    it('refuses a future start that would overlap the live subscription to the same plan', async () => {
      const pack = liveSub({ plan: PACK });
      companySubs = [pack];
      requestedPlan = PACK;
      PACK.amount = 0;
      const start = moment().add(2, 'days');

      const attempt = service.createSubscription(
        buildInput({ startDate: start.toDate() })
      );

      await expect(attempt).rejects.toThrow(
        CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN
      );
      PACK.amount = 9000;
    });
  });
  describe('the whole feature, end to end', () => {
    /**
     * El caso que forzó el Entitlement: *Premium* y un bono a la vez. Se
     * compran por la ruta real —dos `createSubscription`— y luego se pregunta
     * quién paga cada horario, que es la misma pregunta que se hace la reserva.
     *
     * Se usan planes gratuitos para que el cobro siga su camino real (la rama
     * "sin nada que cobrar") y las suscripciones queden ACTIVE como en
     * producción, en vez de fijarles el estado a mano.
     */
    async function buyPremiumAndPack() {
      delete (service as any).attemptCharge;
      PREMIUM.amount = 0;
      PACK.amount = 0;

      requestedPlan = PREMIUM;
      const premium = ((await service.createSubscription(buildInput())) as any)
        .subscription;
      premium.id = 'sub-premium';
      companySubs = [premium];

      requestedPlan = PACK;
      const pack = ((await service.createSubscription(buildInput())) as any)
        .subscription;
      pack.id = 'sub-pack';
      companySubs = [premium, pack];

      PREMIUM.amount = 5000;
      PACK.amount = 9000;
      return { premium, pack };
    }

    it('lets a member hold Premium and a pack, both live and both ACTIVE', async () => {
      const { premium, pack } = await buyPremiumAndPack();

      expect(premium.status).toBe(SubscriptionStatus.ACTIVE);
      expect(pack.status).toBe(SubscriptionStatus.ACTIVE);
      expect(companySubs.filter(liveNow)).toHaveLength(2);
    });

    it('spends a pack credit on the pack schedules and none on the other plan', async () => {
      const { premium, pack } = await buyPremiumAndPack();
      const entitlement = [premium, pack];

      // Horario restringido al plan del bono: paga el bono, con crédito.
      expect(selectPayingSubscription(entitlement, [PACK])).toBe(pack);
      // Restringido a Premium: paga Premium, que es ilimitada — cero créditos.
      const payer = selectPayingSubscription(entitlement, [PREMIUM]);
      expect(payer).toBe(premium);
      expect(payer!.creditsTotal).toBeNull();
    });

    it('keeps each subscription on its own cycle, and cancelling one leaves the other alone', async () => {
      const { premium, pack } = await buyPremiumAndPack();
      premium.isActive = true;
      pack.isActive = true;
      subscriptionById = pack;
      const premiumBefore = { ...premium };

      await service.cancelSubscription({
        subscriptionId: 'sub-pack',
        cancellationReason: 'no me hacen falta',
      } as any);

      // Cada una lleva su propio ciclo y su propio contador de fallos.
      expect(premium.currentPeriodEnd).toEqual(premiumBefore.currentPeriodEnd);
      expect(premium.nextBillingDate).toEqual(premiumBefore.nextBillingDate);
      expect(premium.failedPaymentAttempts).toBe(0);
      expect(premium.status).toBe(SubscriptionStatus.ACTIVE);
      // La cancelación es diferida y solo alcanza a la suscripción nombrada:
      // queda anotada en su historial, y no en el de la otra.
      expect(historyEvents(pack)).toContain('cancel_scheduled');
      expect(historyEvents(premium)).not.toContain('cancel_scheduled');
    });
  });
});
