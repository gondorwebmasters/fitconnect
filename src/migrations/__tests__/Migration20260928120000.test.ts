import { Migration20260928120000 } from '../Migration20260928120000';

/**
 * La migración que añade `paid_by_subscription_id` a la reserva — issue #21.
 *
 * No rellena las reservas existentes porque no hace falta: sin ningún **Session
 * Pack** en producción, ninguna pudo gastar un crédito. Eso es una asunción
 * sobre los datos, así que la migración **la comprueba** antes de tocar nada;
 * si resulta falsa, aborta y el backfill se diseña con los datos delante.
 */
describe('Migration20260928120000 — records who paid for a registration', () => {
  let migration: Migration20260928120000;
  let execute: jest.Mock;

  beforeEach(() => {
    migration = new Migration20260928120000({} as any, {} as any);
    execute = jest.fn(async () => [{ total: 0 }]);
    (migration as any).execute = execute;
  });

  function sql(): string {
    return migration.getQueries().join('\n');
  }

  it('should count the subscriptions carrying a credit total before altering anything', async () => {
    await migration.up();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatch(
      /count\(\*\).*from\s+"subscription".*"credits_total"\s+is\s+not\s+null/is
    );
  });

  it('should add the nullable column and its foreign key when no Session Pack exists', async () => {
    await migration.up();

    expect(sql()).toMatch(
      /alter table "user_schedules" add column "paid_by_subscription_id" uuid null/i
    );
    expect(sql()).toMatch(
      /foreign key \("paid_by_subscription_id"\) references "subscription" \("id"\).*on delete set null/i
    );
  });

  it('should abort when a subscription already carries a credit total', async () => {
    execute.mockResolvedValue([{ total: 3 }]);

    await expect(migration.up()).rejects.toThrow(/3 subscription\(s\)/);
  });

  it('should emit no DDL at all when it aborts', async () => {
    execute.mockResolvedValue([{ total: 1 }]);

    await expect(migration.up()).rejects.toThrow();
    expect(migration.getQueries()).toHaveLength(0);
  });

  it('should abort rather than assume zero when the count does not come back', async () => {
    execute.mockResolvedValue([]);

    await expect(migration.up()).rejects.toThrow(/refuses to assume zero/);
    expect(migration.getQueries()).toHaveLength(0);
  });

  it('should abort when the count comes back in an unexpected shape', async () => {
    execute.mockResolvedValue([{ count: 0 }]);

    await expect(migration.up()).rejects.toThrow(/refuses to assume zero/);
  });

  it('should drop the constraint before the column on the way down', async () => {
    await migration.down();

    const queries = migration.getQueries().map(String);
    expect(queries[0]).toMatch(/drop constraint/i);
    expect(queries[1]).toMatch(/drop column "paid_by_subscription_id"/i);
  });
});
