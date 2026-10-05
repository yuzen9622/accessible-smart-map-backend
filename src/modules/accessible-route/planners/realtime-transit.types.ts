/**
 * File-local TDX shapes and cache types for the realtime transit overlay.
 * Minimal shapes scoped to this planner — not the canonical src/types/transit.
 */

import type { BusEtaTiming } from "../../../types/transit";
import type { RailOdSuspension } from "../../../types/rail";

export interface TdxEtaRecord extends BusEtaTiming {
  StopName?: { Zh_tw?: string };
  Direction?: number;
  StopSequence?: number;
  NextBusTime?: string;
  PlateNumb?: string;
}

/** Minimal shape of TDX Bus/RealTimeNearStop (on-road vehicle positions by stop). */
export interface TdxRealTimeNearStopRecord {
  PlateNumb?: string;
  Direction?: number;
  StopSequence?: number;
  BusStatus?: number;
}
export type TdxRealTimeByFrequencyRecord = TdxRealTimeNearStopRecord;

export interface TdxTrainLiveBoardItem {
  TrainNo?: string;
  DelayTime?: number;
}
export interface TdxTrainLiveBoardEnvelope {
  TrainLiveBoards?: TdxTrainLiveBoardItem[];
}

export type CacheEntry<T> = { data: T; expiresAt: number };

export interface TdxTraStation {
  StationID: string;
  StationName?: { Zh_tw?: string };
}
export type TdxTraOdItem = RailOdRow;

export interface TdxThsrStation {
  StationID: string;
  StationName?: { Zh_tw?: string };
}
export interface TdxThsrOdItem {
  DailyTrainInfo?: { TrainNo?: string };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
}

export interface RailOdRow extends RailOdSuspension {
  DailyTrainInfo?: {
    TrainNo?: string;
    TrainTypeName?: { Zh_tw?: string };
    SuspendedFlag?: number;
  };
  OriginStopTime?: { DepartureTime?: string; SuspendedFlag?: number };
  DestinationStopTime?: { ArrivalTime?: string; SuspendedFlag?: number };
}
export interface RailMatch {
  trainNo: string;
  trainType?: string;
  dep: string;
  arr: string;
}
