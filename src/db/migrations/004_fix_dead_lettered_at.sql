-- CWIDS Migration 004: Add dead_lettered_at column to event_deliveries
-- Fixes missing column required by DeliveriesRepo queries.
-- Safe on populated tables: adds nullable column with no default lock.

SET search_path TO cwids, public;

ALTER TABLE cwids.event_deliveries 
ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
