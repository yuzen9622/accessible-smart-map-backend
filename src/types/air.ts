export interface STAObservation {
  "@iot.selfLink": string;
  "@iot.id": number;
  phenomenonTime: string;
  resultTime: string;
  result: number;
}

export interface STAThingProperties {
  city?: string;
  areaType?: string;
  areaDescription?: string;
  stationID?: string;
  stationName?: string;
  area?: string;
}

export interface STAThing {
  "@iot.id": number;
  "@iot.selfLink": string;
  description?: string;
  name?: string;
  properties: STAThingProperties;
}

export interface STADatastream {
  "@iot.id": number;
  "@iot.selfLink": string;
  name: string;
  description?: string;
  observedArea?: {
    type: string;
    coordinates: [number, number];
  };
  Thing: STAThing;
  Observations: STAObservation[];
}

export interface STAApiResponse {
  "@odata.count": number;
  value: STADatastream[];
}

export interface AIResponse {
  description: string;
  quality:
    | ""
    | "GOOD"
    | "MODERATE"
    | "UNHEALTHY_SENSITIVE"
    | "UNHEALTHY"
    | "VERY_UNHEALTHY"
    | "HAZARDOUS";
}
