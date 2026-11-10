-- audit_log is append-only. Two independent guards:
--   1. the trigger rejects UPDATE, DELETE and TRUNCATE for every role, the table owner included;
--   2. the application role loses the privileges outright (default privileges grant it
--      SELECT, INSERT, UPDATE, DELETE on every new table, so the REVOKE below is what removes them).
CREATE FUNCTION audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM darling_app;
