import { Migration } from '@mikro-orm/migrations';

/**
 * Restricted Schedule (Horario Restringido) — migración aditiva.
 *
 * - schedule_allowed_plans: pivote N:M entre `schedule` y `plan`. Sin filas ⇒
 *   schedule sin restricción, que es el estado de todos los schedules
 *   existentes: la migración no cambia ningún comportamiento observable.
 * - Tenancy: un schedule solo puede referenciar planes de **su propia**
 *   empresa. La ruta de escritura ya lo garantiza vía el filtro
 *   `companyContext`, pero el invariante se ancla además en la base con un
 *   trigger, porque una fila mal insertada aquí abriría una clase de una
 *   empresa a los planes de otra.
 *
 * Ver ADR 0005 y CONTEXT.md → Restricted Schedule.
 */
export class Migration20260923120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "schedule_allowed_plans" ("schedule_id" uuid not null, "plan_id" uuid not null, constraint "schedule_allowed_plans_pkey" primary key ("schedule_id", "plan_id"));`
    );
    this.addSql(
      `alter table "schedule_allowed_plans" add constraint "schedule_allowed_plans_schedule_id_foreign" foreign key ("schedule_id") references "schedule" ("id") on update cascade on delete cascade;`
    );
    this.addSql(
      `alter table "schedule_allowed_plans" add constraint "schedule_allowed_plans_plan_id_foreign" foreign key ("plan_id") references "plan" ("id") on update cascade on delete cascade;`
    );
    this.addSql(
      `create index "schedule_allowed_plans_plan_id_index" on "schedule_allowed_plans" ("plan_id");`
    );

    this.addSql(`
      create or replace function "schedule_allowed_plans_same_company"() returns trigger as $$
      begin
        if not exists (
          select 1
          from "schedule" s
          join "plan" p on p."company_id" = s."company_id"
          where s."id" = new."schedule_id" and p."id" = new."plan_id"
        ) then
          raise exception 'plan % does not belong to the company of schedule %', new."plan_id", new."schedule_id";
        end if;
        return new;
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger "schedule_allowed_plans_same_company_trigger"
      before insert or update on "schedule_allowed_plans"
      for each row execute function "schedule_allowed_plans_same_company"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop trigger if exists "schedule_allowed_plans_same_company_trigger" on "schedule_allowed_plans";`
    );
    this.addSql(
      `drop function if exists "schedule_allowed_plans_same_company"();`
    );
    this.addSql(`drop table if exists "schedule_allowed_plans";`);
  }
}
