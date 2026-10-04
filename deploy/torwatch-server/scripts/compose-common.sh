#!/usr/bin/env bash

torwatch_compose_files() {
  COMPOSE_FILES=(-f compose.yaml)
  if [ "${TORWATCH_DB_MODE:-bundled}" = "shared" ]; then
    COMPOSE_FILES+=(-f compose.shared-db.yaml)
  fi
  if [ "${TORWATCH_MODE:-direct}" = "embedded-vpn" ]; then
    COMPOSE_FILES+=(-f compose.vpn.yaml)
  fi
  if [ "${TORWATCH_VERIFY_FIXTURES:-0}" = "1" ]; then
    COMPOSE_FILES+=(-f compose.verify.yaml)
  fi
}

torwatch_db_exec() {
  if [ "${TORWATCH_DB_MODE:-bundled}" = "shared" ]; then
    docker exec -i "${POSTGRES_CONTAINER:-homelab-postgres}" "$@"
  else
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres "$@"
  fi
}

torwatch_db_admin_psql() {
  if [ "${TORWATCH_DB_MODE:-bundled}" = "shared" ]; then
    docker exec -i "${POSTGRES_CONTAINER:-homelab-postgres}" \
      sh -c 'exec psql -U "$POSTGRES_USER" "$@"' sh "$@"
  else
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
      psql -U "${POSTGRES_USER:-torwatch}" "$@"
  fi
}
