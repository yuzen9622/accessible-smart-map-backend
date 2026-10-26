// Actual schema7 native HTTP captures from a controlled synthetic graph; not national-source acceptance.
// Source SHA256: 8396d3f44dcff878b90edacfed89f699deb6de41782e42edaf4dc180eafebd0f
export const otpWalkNativeResponses = {
  forward: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          byteCount: 18686,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          graphByteCount: 18686,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
          layerReportSha256:
            "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
          declaredBuildPolicyJarSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          inputs: [
            {
              path: "build-config.json",
              role: "CONFIG",
              sha256:
                "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
              byteCount: 187,
            },
            {
              path: "fixture.gtfs.zip",
              role: "GTFS",
              sha256:
                "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
              byteCount: 1113,
            },
            {
              path: "merged.osm.pbf",
              role: "OSM",
              sha256:
                "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
              byteCount: 1215,
            },
            {
              path: "router-config.json",
              role: "CONFIG",
              sha256:
                "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
              byteCount: 1593,
            },
          ],
          compilerArtifacts: [
            {
              path: "build-ped-graph.py",
              role: "DEPENDENCY",
              sha256:
                "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
              byteCount: 74699,
            },
            {
              path: "osm-area-polygon-features.json",
              role: "DEPENDENCY",
              sha256:
                "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
              byteCount: 2753,
            },
            {
              path: "otp-sidewalk-layer.py",
              role: "COMPILER",
              sha256:
                "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
              byteCount: 102958,
            },
            {
              path: "otp-sidewalk-topology.py",
              role: "TOPOLOGY",
              sha256:
                "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
              byteCount: 7728,
            },
            {
              path: "ped-osm-areas.py",
              role: "DEPENDENCY",
              sha256:
                "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
              byteCount: 19272,
            },
            {
              path: "ped-sidewalk-network.py",
              role: "DEPENDENCY",
              sha256:
                "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
              byteCount: 56319,
            },
          ],
        },
        runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
        runtimePolicyIdentity: {
          status: "VERIFIED_OBSERVED_POLICY_CLASSES",
          reason: "TRUSTED_LAUNCHER_BOUNDARY",
          artifactSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          manifestSha256:
            "bccf6a39436903f7119ee185744001d59c43a6b3fc8f8c0a0eb41cf505c3e26f",
          observedClassDigestSha256:
            "92476a059bce2fd5bbd1a6f9e5b3e7d577eef0c7edc307fd006e815dd9fa66e2",
          classCount: 56,
        },
      },
      plan: {
        routingErrors: [],
        directWalkSearch: {
          schemaVersion: "1",
          status: "FOUND",
          nativeOutcome: "TARGET_REACHED",
          executedPolicy: {
            schemaVersion: "1",
            scope: "DIRECT_WALK_ONLY",
            profile: "NORMAL",
            wheelchairEnabled: false,
            walkSpeedMps: 1.3,
            stairsReluctance: 12.0,
            minimumKnownWidthM: null,
            maximumKnownNonStairSlopeRatio: null,
            fareAccess: "FORBID",
          },
          fromLat: 25.0000001,
          fromLon: 121.0034567,
          toLat: 25.0000001,
          toLon: 121.0154321,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [
          {
            legs: [
              {
                mode: "WALK",
                distance: 1206.85,
                duration: 929.0,
                startTime: 1792980000000,
                endTime: 1792980929000,
                from: {
                  lat: 25.0000001,
                  lon: 121.0034567,
                },
                to: {
                  lat: 25.0000001,
                  lon: 121.0154321,
                },
                legGeometry: {
                  points: "_yqwCqnpaV?uH@ySAmI?kI?{S?uA",
                },
                walkEvidence: {
                  schemaVersion: "7",
                  captureScope: "LEG_STATES_BACK_EDGES",
                  graphIdentityStatus: "VERIFIED_LOADED_BYTES",
                  executedPolicy: {
                    schemaVersion: "1",
                    scope: "DIRECT_WALK_ONLY",
                    profile: "NORMAL",
                    wheelchairEnabled: false,
                    walkSpeedMps: 1.3,
                    stairsReluctance: 12.0,
                    minimumKnownWidthM: null,
                    maximumKnownNonStairSlopeRatio: null,
                    fareAccess: "FORBID",
                  },
                  graphByteIdentity: {
                    sha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    byteCount: 18686,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    graphByteCount: 18686,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                    layerReportSha256:
                      "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
                    declaredBuildPolicyJarSha256:
                      "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
                    inputs: [
                      {
                        path: "build-config.json",
                        role: "CONFIG",
                        sha256:
                          "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
                        byteCount: 187,
                      },
                      {
                        path: "fixture.gtfs.zip",
                        role: "GTFS",
                        sha256:
                          "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
                        byteCount: 1113,
                      },
                      {
                        path: "merged.osm.pbf",
                        role: "OSM",
                        sha256:
                          "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                        byteCount: 1215,
                      },
                      {
                        path: "router-config.json",
                        role: "CONFIG",
                        sha256:
                          "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
                        byteCount: 1593,
                      },
                    ],
                    compilerArtifacts: [
                      {
                        path: "build-ped-graph.py",
                        role: "DEPENDENCY",
                        sha256:
                          "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
                        byteCount: 74699,
                      },
                      {
                        path: "osm-area-polygon-features.json",
                        role: "DEPENDENCY",
                        sha256:
                          "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
                        byteCount: 2753,
                      },
                      {
                        path: "otp-sidewalk-layer.py",
                        role: "COMPILER",
                        sha256:
                          "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
                        byteCount: 102958,
                      },
                      {
                        path: "otp-sidewalk-topology.py",
                        role: "TOPOLOGY",
                        sha256:
                          "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
                        byteCount: 7728,
                      },
                      {
                        path: "ped-osm-areas.py",
                        role: "DEPENDENCY",
                        sha256:
                          "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
                        byteCount: 19272,
                      },
                      {
                        path: "ped-sidewalk-network.py",
                        role: "DEPENDENCY",
                        sha256:
                          "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
                        byteCount: 56319,
                      },
                    ],
                  },
                  edgeOccurrenceCount: 5,
                  nonStreetEdgeCount: 2,
                  unknownMetadataEdgeCount: 2,
                  edges: [
                    {
                      occurrenceIndex: 0,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 1,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 155.529,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "10",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 2,
                      edgeKind: "StreetEdge",
                      distanceM: 1007.774,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "21",
                      sourceSegmentIndex: 3,
                      reverse: false,
                      knownWidthM: 2.0,
                      sourceRefs: ["fixture-0"],
                      widthSourceRefs: ["fixture-0"],
                      sourceBatch: "fixture",
                      sourceVersion: "fixture",
                      sourceSha256:
                        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 3,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 43.545,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "20",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 4,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                  ],
                  selectedPath: {
                    geometryCoverageStatus: "NATIVE_GEOMETRY_GAPS",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0000001,
                      lon: 121.0034567,
                    },
                    requestTo: {
                      lat: 25.0000001,
                      lon: 121.0154321,
                    },
                    startState: {
                      lat: 25.0000001,
                      lon: 121.0034567,
                    },
                    endState: {
                      lat: 25.0000001,
                      lon: 121.0154321,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0034567,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0154321,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.011119492779154694,
                    requestToToLastGeometryGapM: 0.011119492779154694,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 1206.8482348442515,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0000001,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.011119492779154694,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 155.529,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0034567,
                          },
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                        ],
                        vertexGapM: 155.52887849193957,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 155.52887849193957,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 1007.774,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                          {
                            lat: 24.999993,
                            lon: 121.008333,
                          },
                          {
                            lat: 25.0,
                            lon: 121.01,
                          },
                          {
                            lat: 25.000007,
                            lon: 121.011667,
                          },
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                        ],
                        vertexGapM: 1007.7682787413871,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 1007.7736890183071,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 43.545,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0154321,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                          {
                            lat: 25.0,
                            lon: 121.0154321,
                          },
                        ],
                        vertexGapM: 43.54566733400469,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 43.54566733400469,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0154321,
                        },
                        traversalTo: {
                          lat: 25.0000001,
                          lon: 121.0154321,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.011119492779154694,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
  reverse: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          byteCount: 18686,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          graphByteCount: 18686,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
          layerReportSha256:
            "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
          declaredBuildPolicyJarSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          inputs: [
            {
              path: "build-config.json",
              role: "CONFIG",
              sha256:
                "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
              byteCount: 187,
            },
            {
              path: "fixture.gtfs.zip",
              role: "GTFS",
              sha256:
                "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
              byteCount: 1113,
            },
            {
              path: "merged.osm.pbf",
              role: "OSM",
              sha256:
                "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
              byteCount: 1215,
            },
            {
              path: "router-config.json",
              role: "CONFIG",
              sha256:
                "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
              byteCount: 1593,
            },
          ],
          compilerArtifacts: [
            {
              path: "build-ped-graph.py",
              role: "DEPENDENCY",
              sha256:
                "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
              byteCount: 74699,
            },
            {
              path: "osm-area-polygon-features.json",
              role: "DEPENDENCY",
              sha256:
                "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
              byteCount: 2753,
            },
            {
              path: "otp-sidewalk-layer.py",
              role: "COMPILER",
              sha256:
                "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
              byteCount: 102958,
            },
            {
              path: "otp-sidewalk-topology.py",
              role: "TOPOLOGY",
              sha256:
                "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
              byteCount: 7728,
            },
            {
              path: "ped-osm-areas.py",
              role: "DEPENDENCY",
              sha256:
                "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
              byteCount: 19272,
            },
            {
              path: "ped-sidewalk-network.py",
              role: "DEPENDENCY",
              sha256:
                "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
              byteCount: 56319,
            },
          ],
        },
        runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
        runtimePolicyIdentity: {
          status: "VERIFIED_OBSERVED_POLICY_CLASSES",
          reason: "TRUSTED_LAUNCHER_BOUNDARY",
          artifactSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          manifestSha256:
            "bccf6a39436903f7119ee185744001d59c43a6b3fc8f8c0a0eb41cf505c3e26f",
          observedClassDigestSha256:
            "92476a059bce2fd5bbd1a6f9e5b3e7d577eef0c7edc307fd006e815dd9fa66e2",
          classCount: 56,
        },
      },
      plan: {
        routingErrors: [],
        directWalkSearch: {
          schemaVersion: "1",
          status: "FOUND",
          nativeOutcome: "TARGET_REACHED",
          executedPolicy: {
            schemaVersion: "1",
            scope: "DIRECT_WALK_ONLY",
            profile: "NORMAL",
            wheelchairEnabled: false,
            walkSpeedMps: 1.3,
            stairsReluctance: 12.0,
            minimumKnownWidthM: null,
            maximumKnownNonStairSlopeRatio: null,
            fareAccess: "FORBID",
          },
          fromLat: 25.0000001,
          fromLon: 121.0154321,
          toLat: 25.0000001,
          toLon: 121.0034567,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [
          {
            legs: [
              {
                mode: "WALK",
                distance: 1206.85,
                duration: 929.0,
                startTime: 1792980000000,
                endTime: 1792980929000,
                from: {
                  lat: 25.0000001,
                  lon: 121.0154321,
                },
                to: {
                  lat: 25.0000001,
                  lon: 121.0034567,
                },
                legGeometry: {
                  points: "_yqwCmyraV?tA?zS?jI@lIAxS?tH",
                },
                walkEvidence: {
                  schemaVersion: "7",
                  captureScope: "LEG_STATES_BACK_EDGES",
                  graphIdentityStatus: "VERIFIED_LOADED_BYTES",
                  executedPolicy: {
                    schemaVersion: "1",
                    scope: "DIRECT_WALK_ONLY",
                    profile: "NORMAL",
                    wheelchairEnabled: false,
                    walkSpeedMps: 1.3,
                    stairsReluctance: 12.0,
                    minimumKnownWidthM: null,
                    maximumKnownNonStairSlopeRatio: null,
                    fareAccess: "FORBID",
                  },
                  graphByteIdentity: {
                    sha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    byteCount: 18686,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    graphByteCount: 18686,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                    layerReportSha256:
                      "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
                    declaredBuildPolicyJarSha256:
                      "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
                    inputs: [
                      {
                        path: "build-config.json",
                        role: "CONFIG",
                        sha256:
                          "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
                        byteCount: 187,
                      },
                      {
                        path: "fixture.gtfs.zip",
                        role: "GTFS",
                        sha256:
                          "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
                        byteCount: 1113,
                      },
                      {
                        path: "merged.osm.pbf",
                        role: "OSM",
                        sha256:
                          "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                        byteCount: 1215,
                      },
                      {
                        path: "router-config.json",
                        role: "CONFIG",
                        sha256:
                          "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
                        byteCount: 1593,
                      },
                    ],
                    compilerArtifacts: [
                      {
                        path: "build-ped-graph.py",
                        role: "DEPENDENCY",
                        sha256:
                          "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
                        byteCount: 74699,
                      },
                      {
                        path: "osm-area-polygon-features.json",
                        role: "DEPENDENCY",
                        sha256:
                          "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
                        byteCount: 2753,
                      },
                      {
                        path: "otp-sidewalk-layer.py",
                        role: "COMPILER",
                        sha256:
                          "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
                        byteCount: 102958,
                      },
                      {
                        path: "otp-sidewalk-topology.py",
                        role: "TOPOLOGY",
                        sha256:
                          "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
                        byteCount: 7728,
                      },
                      {
                        path: "ped-osm-areas.py",
                        role: "DEPENDENCY",
                        sha256:
                          "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
                        byteCount: 19272,
                      },
                      {
                        path: "ped-sidewalk-network.py",
                        role: "DEPENDENCY",
                        sha256:
                          "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
                        byteCount: 56319,
                      },
                    ],
                  },
                  edgeOccurrenceCount: 5,
                  nonStreetEdgeCount: 2,
                  unknownMetadataEdgeCount: 2,
                  edges: [
                    {
                      occurrenceIndex: 0,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 1,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 43.545,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "20",
                      sourceSegmentIndex: 0,
                      reverse: true,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 2,
                      edgeKind: "StreetEdge",
                      distanceM: 1007.774,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "21",
                      sourceSegmentIndex: 3,
                      reverse: true,
                      knownWidthM: 2.0,
                      sourceRefs: ["fixture-0"],
                      widthSourceRefs: ["fixture-0"],
                      sourceBatch: "fixture",
                      sourceVersion: "fixture",
                      sourceSha256:
                        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 3,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 155.529,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "10",
                      sourceSegmentIndex: 0,
                      reverse: true,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 4,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                  ],
                  selectedPath: {
                    geometryCoverageStatus: "NATIVE_GEOMETRY_GAPS",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0000001,
                      lon: 121.0154321,
                    },
                    requestTo: {
                      lat: 25.0000001,
                      lon: 121.0034567,
                    },
                    startState: {
                      lat: 25.0000001,
                      lon: 121.0154321,
                    },
                    endState: {
                      lat: 25.0000001,
                      lon: 121.0034567,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0154321,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0034567,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.011119492779154694,
                    requestToToLastGeometryGapM: 0.011119492779154694,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 1206.8482348442515,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0000001,
                          lon: 121.0154321,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0154321,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.011119492779154694,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 43.545,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0154321,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0154321,
                          },
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                        ],
                        vertexGapM: 43.54566733400469,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 43.54566733400469,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 1007.774,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                          {
                            lat: 25.000007,
                            lon: 121.011667,
                          },
                          {
                            lat: 25.0,
                            lon: 121.01,
                          },
                          {
                            lat: 24.999993,
                            lon: 121.008333,
                          },
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                        ],
                        vertexGapM: 1007.7682787413871,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 1007.7736890183072,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 155.529,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                          {
                            lat: 25.0,
                            lon: 121.0034567,
                          },
                        ],
                        vertexGapM: 155.52887849193957,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 155.52887849193957,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0000001,
                          lon: 121.0034567,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.011119492779154694,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
  wheelchair: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          byteCount: 18686,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          graphByteCount: 18686,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
          layerReportSha256:
            "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
          declaredBuildPolicyJarSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          inputs: [
            {
              path: "build-config.json",
              role: "CONFIG",
              sha256:
                "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
              byteCount: 187,
            },
            {
              path: "fixture.gtfs.zip",
              role: "GTFS",
              sha256:
                "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
              byteCount: 1113,
            },
            {
              path: "merged.osm.pbf",
              role: "OSM",
              sha256:
                "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
              byteCount: 1215,
            },
            {
              path: "router-config.json",
              role: "CONFIG",
              sha256:
                "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
              byteCount: 1593,
            },
          ],
          compilerArtifacts: [
            {
              path: "build-ped-graph.py",
              role: "DEPENDENCY",
              sha256:
                "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
              byteCount: 74699,
            },
            {
              path: "osm-area-polygon-features.json",
              role: "DEPENDENCY",
              sha256:
                "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
              byteCount: 2753,
            },
            {
              path: "otp-sidewalk-layer.py",
              role: "COMPILER",
              sha256:
                "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
              byteCount: 102958,
            },
            {
              path: "otp-sidewalk-topology.py",
              role: "TOPOLOGY",
              sha256:
                "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
              byteCount: 7728,
            },
            {
              path: "ped-osm-areas.py",
              role: "DEPENDENCY",
              sha256:
                "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
              byteCount: 19272,
            },
            {
              path: "ped-sidewalk-network.py",
              role: "DEPENDENCY",
              sha256:
                "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
              byteCount: 56319,
            },
          ],
        },
        runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
        runtimePolicyIdentity: {
          status: "VERIFIED_OBSERVED_POLICY_CLASSES",
          reason: "TRUSTED_LAUNCHER_BOUNDARY",
          artifactSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          manifestSha256:
            "bccf6a39436903f7119ee185744001d59c43a6b3fc8f8c0a0eb41cf505c3e26f",
          observedClassDigestSha256:
            "92476a059bce2fd5bbd1a6f9e5b3e7d577eef0c7edc307fd006e815dd9fa66e2",
          classCount: 56,
        },
      },
      plan: {
        routingErrors: [],
        directWalkSearch: {
          schemaVersion: "1",
          status: "FOUND",
          nativeOutcome: "TARGET_REACHED",
          executedPolicy: {
            schemaVersion: "1",
            scope: "DIRECT_WALK_ONLY",
            profile: "WHEELCHAIR_STRICT",
            wheelchairEnabled: true,
            walkSpeedMps: 0.8,
            stairsReluctance: 12.0,
            minimumKnownWidthM: 0.9,
            maximumKnownNonStairSlopeRatio: 0.12,
            fareAccess: "FORBID",
          },
          fromLat: 25.0000001,
          fromLon: 121.0034567,
          toLat: 25.0000001,
          toLon: 121.0154321,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [
          {
            legs: [
              {
                mode: "WALK",
                distance: 1206.85,
                duration: 1509.0,
                startTime: 1792980000000,
                endTime: 1792981509000,
                from: {
                  lat: 25.0000001,
                  lon: 121.0034567,
                },
                to: {
                  lat: 25.0000001,
                  lon: 121.0154321,
                },
                legGeometry: {
                  points: "_yqwCqnpaV?uH@ySAmI?kI?{S?uA",
                },
                walkEvidence: {
                  schemaVersion: "7",
                  captureScope: "LEG_STATES_BACK_EDGES",
                  graphIdentityStatus: "VERIFIED_LOADED_BYTES",
                  executedPolicy: {
                    schemaVersion: "1",
                    scope: "DIRECT_WALK_ONLY",
                    profile: "WHEELCHAIR_STRICT",
                    wheelchairEnabled: true,
                    walkSpeedMps: 0.8,
                    stairsReluctance: 12.0,
                    minimumKnownWidthM: 0.9,
                    maximumKnownNonStairSlopeRatio: 0.12,
                    fareAccess: "FORBID",
                  },
                  graphByteIdentity: {
                    sha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    byteCount: 18686,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    graphByteCount: 18686,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                    layerReportSha256:
                      "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
                    declaredBuildPolicyJarSha256:
                      "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
                    inputs: [
                      {
                        path: "build-config.json",
                        role: "CONFIG",
                        sha256:
                          "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
                        byteCount: 187,
                      },
                      {
                        path: "fixture.gtfs.zip",
                        role: "GTFS",
                        sha256:
                          "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
                        byteCount: 1113,
                      },
                      {
                        path: "merged.osm.pbf",
                        role: "OSM",
                        sha256:
                          "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                        byteCount: 1215,
                      },
                      {
                        path: "router-config.json",
                        role: "CONFIG",
                        sha256:
                          "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
                        byteCount: 1593,
                      },
                    ],
                    compilerArtifacts: [
                      {
                        path: "build-ped-graph.py",
                        role: "DEPENDENCY",
                        sha256:
                          "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
                        byteCount: 74699,
                      },
                      {
                        path: "osm-area-polygon-features.json",
                        role: "DEPENDENCY",
                        sha256:
                          "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
                        byteCount: 2753,
                      },
                      {
                        path: "otp-sidewalk-layer.py",
                        role: "COMPILER",
                        sha256:
                          "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
                        byteCount: 102958,
                      },
                      {
                        path: "otp-sidewalk-topology.py",
                        role: "TOPOLOGY",
                        sha256:
                          "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
                        byteCount: 7728,
                      },
                      {
                        path: "ped-osm-areas.py",
                        role: "DEPENDENCY",
                        sha256:
                          "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
                        byteCount: 19272,
                      },
                      {
                        path: "ped-sidewalk-network.py",
                        role: "DEPENDENCY",
                        sha256:
                          "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
                        byteCount: 56319,
                      },
                    ],
                  },
                  edgeOccurrenceCount: 5,
                  nonStreetEdgeCount: 2,
                  unknownMetadataEdgeCount: 2,
                  edges: [
                    {
                      occurrenceIndex: 0,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 1,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 155.529,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "10",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 2,
                      edgeKind: "StreetEdge",
                      distanceM: 1007.774,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "21",
                      sourceSegmentIndex: 3,
                      reverse: false,
                      knownWidthM: 2.0,
                      sourceRefs: ["fixture-0"],
                      widthSourceRefs: ["fixture-0"],
                      sourceBatch: "fixture",
                      sourceVersion: "fixture",
                      sourceSha256:
                        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 3,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 43.545,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "20",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 4,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                  ],
                  selectedPath: {
                    geometryCoverageStatus: "NATIVE_GEOMETRY_GAPS",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0000001,
                      lon: 121.0034567,
                    },
                    requestTo: {
                      lat: 25.0000001,
                      lon: 121.0154321,
                    },
                    startState: {
                      lat: 25.0000001,
                      lon: 121.0034567,
                    },
                    endState: {
                      lat: 25.0000001,
                      lon: 121.0154321,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0034567,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0154321,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.011119492779154694,
                    requestToToLastGeometryGapM: 0.011119492779154694,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 1206.8482348442515,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0000001,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.011119492779154694,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 155.529,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0034567,
                          },
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                        ],
                        vertexGapM: 155.52887849193957,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 155.52887849193957,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 1007.774,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                          {
                            lat: 24.999993,
                            lon: 121.008333,
                          },
                          {
                            lat: 25.0,
                            lon: 121.01,
                          },
                          {
                            lat: 25.000007,
                            lon: 121.011667,
                          },
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                        ],
                        vertexGapM: 1007.7682787413871,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 1007.7736890183071,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 43.545,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0154321,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                          {
                            lat: 25.0,
                            lon: 121.0154321,
                          },
                        ],
                        vertexGapM: 43.54566733400469,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 43.54566733400469,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0154321,
                        },
                        traversalTo: {
                          lat: 25.0000001,
                          lon: 121.0154321,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.011119492779154694,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
  offstreet_gap: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          byteCount: 18686,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          graphByteCount: 18686,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
          layerReportSha256:
            "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
          declaredBuildPolicyJarSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          inputs: [
            {
              path: "build-config.json",
              role: "CONFIG",
              sha256:
                "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
              byteCount: 187,
            },
            {
              path: "fixture.gtfs.zip",
              role: "GTFS",
              sha256:
                "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
              byteCount: 1113,
            },
            {
              path: "merged.osm.pbf",
              role: "OSM",
              sha256:
                "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
              byteCount: 1215,
            },
            {
              path: "router-config.json",
              role: "CONFIG",
              sha256:
                "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
              byteCount: 1593,
            },
          ],
          compilerArtifacts: [
            {
              path: "build-ped-graph.py",
              role: "DEPENDENCY",
              sha256:
                "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
              byteCount: 74699,
            },
            {
              path: "osm-area-polygon-features.json",
              role: "DEPENDENCY",
              sha256:
                "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
              byteCount: 2753,
            },
            {
              path: "otp-sidewalk-layer.py",
              role: "COMPILER",
              sha256:
                "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
              byteCount: 102958,
            },
            {
              path: "otp-sidewalk-topology.py",
              role: "TOPOLOGY",
              sha256:
                "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
              byteCount: 7728,
            },
            {
              path: "ped-osm-areas.py",
              role: "DEPENDENCY",
              sha256:
                "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
              byteCount: 19272,
            },
            {
              path: "ped-sidewalk-network.py",
              role: "DEPENDENCY",
              sha256:
                "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
              byteCount: 56319,
            },
          ],
        },
        runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
        runtimePolicyIdentity: {
          status: "VERIFIED_OBSERVED_POLICY_CLASSES",
          reason: "TRUSTED_LAUNCHER_BOUNDARY",
          artifactSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          manifestSha256:
            "bccf6a39436903f7119ee185744001d59c43a6b3fc8f8c0a0eb41cf505c3e26f",
          observedClassDigestSha256:
            "92476a059bce2fd5bbd1a6f9e5b3e7d577eef0c7edc307fd006e815dd9fa66e2",
          classCount: 56,
        },
      },
      plan: {
        routingErrors: [],
        directWalkSearch: {
          schemaVersion: "1",
          status: "FOUND",
          nativeOutcome: "TARGET_REACHED",
          executedPolicy: {
            schemaVersion: "1",
            scope: "DIRECT_WALK_ONLY",
            profile: "NORMAL",
            wheelchairEnabled: false,
            walkSpeedMps: 1.3,
            stairsReluctance: 12.0,
            minimumKnownWidthM: null,
            maximumKnownNonStairSlopeRatio: null,
            fareAccess: "FORBID",
          },
          fromLat: 25.0001,
          fromLon: 121.0034567,
          toLat: 25.0001,
          toLon: 121.0154321,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [
          {
            legs: [
              {
                mode: "WALK",
                distance: 1206.85,
                duration: 929.0,
                startTime: 1792980000000,
                endTime: 1792980929000,
                from: {
                  lat: 25.0001,
                  lon: 121.0034567,
                },
                to: {
                  lat: 25.0001,
                  lon: 121.0154321,
                },
                legGeometry: {
                  points: "_yqwCqnpaV?uH@ySAmI?kI?{S?uA",
                },
                walkEvidence: {
                  schemaVersion: "7",
                  captureScope: "LEG_STATES_BACK_EDGES",
                  graphIdentityStatus: "VERIFIED_LOADED_BYTES",
                  executedPolicy: {
                    schemaVersion: "1",
                    scope: "DIRECT_WALK_ONLY",
                    profile: "NORMAL",
                    wheelchairEnabled: false,
                    walkSpeedMps: 1.3,
                    stairsReluctance: 12.0,
                    minimumKnownWidthM: null,
                    maximumKnownNonStairSlopeRatio: null,
                    fareAccess: "FORBID",
                  },
                  graphByteIdentity: {
                    sha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    byteCount: 18686,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
                    graphByteCount: 18686,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                    layerReportSha256:
                      "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
                    declaredBuildPolicyJarSha256:
                      "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
                    inputs: [
                      {
                        path: "build-config.json",
                        role: "CONFIG",
                        sha256:
                          "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
                        byteCount: 187,
                      },
                      {
                        path: "fixture.gtfs.zip",
                        role: "GTFS",
                        sha256:
                          "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
                        byteCount: 1113,
                      },
                      {
                        path: "merged.osm.pbf",
                        role: "OSM",
                        sha256:
                          "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
                        byteCount: 1215,
                      },
                      {
                        path: "router-config.json",
                        role: "CONFIG",
                        sha256:
                          "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
                        byteCount: 1593,
                      },
                    ],
                    compilerArtifacts: [
                      {
                        path: "build-ped-graph.py",
                        role: "DEPENDENCY",
                        sha256:
                          "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
                        byteCount: 74699,
                      },
                      {
                        path: "osm-area-polygon-features.json",
                        role: "DEPENDENCY",
                        sha256:
                          "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
                        byteCount: 2753,
                      },
                      {
                        path: "otp-sidewalk-layer.py",
                        role: "COMPILER",
                        sha256:
                          "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
                        byteCount: 102958,
                      },
                      {
                        path: "otp-sidewalk-topology.py",
                        role: "TOPOLOGY",
                        sha256:
                          "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
                        byteCount: 7728,
                      },
                      {
                        path: "ped-osm-areas.py",
                        role: "DEPENDENCY",
                        sha256:
                          "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
                        byteCount: 19272,
                      },
                      {
                        path: "ped-sidewalk-network.py",
                        role: "DEPENDENCY",
                        sha256:
                          "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
                        byteCount: 56319,
                      },
                    ],
                  },
                  edgeOccurrenceCount: 5,
                  nonStreetEdgeCount: 2,
                  unknownMetadataEdgeCount: 2,
                  edges: [
                    {
                      occurrenceIndex: 0,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 1,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 155.529,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "10",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 2,
                      edgeKind: "StreetEdge",
                      distanceM: 1007.774,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "21",
                      sourceSegmentIndex: 3,
                      reverse: false,
                      knownWidthM: 2.0,
                      sourceRefs: ["fixture-0"],
                      widthSourceRefs: ["fixture-0"],
                      sourceBatch: "fixture",
                      sourceVersion: "fixture",
                      sourceSha256:
                        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 3,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 43.545,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "20",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: false,
                        escalator: false,
                        nativeWheelchairAccessible: true,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 4,
                      edgeKind: "TemporaryFreeEdge",
                      distanceM: 0.0,
                      metadataStatus: "UNKNOWN",
                      partial: false,
                      osmWayId: null,
                      sourceSegmentIndex: null,
                      reverse: null,
                      knownWidthM: null,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: "NON_STREET_METADATA_UNAVAILABLE",
                      policyEvaluation: {
                        captureSchemaVersion: null,
                        stairs: null,
                        escalator: null,
                        nativeWheelchairAccessible: null,
                        knownMaxSlopeRatio: null,
                        knownWidthM: null,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                  ],
                  selectedPath: {
                    geometryCoverageStatus: "NATIVE_GEOMETRY_GAPS",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0001,
                      lon: 121.0034567,
                    },
                    requestTo: {
                      lat: 25.0001,
                      lon: 121.0154321,
                    },
                    startState: {
                      lat: 25.0001,
                      lon: 121.0034567,
                    },
                    endState: {
                      lat: 25.0001,
                      lon: 121.0154321,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0034567,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.01543209999998,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 11.119492664568355,
                    requestToToLastGeometryGapM: 11.119492664568355,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 1206.8482348428192,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0001,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 11.119492664568355,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 155.529,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0034567,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0034567,
                          },
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                        ],
                        vertexGapM: 155.52887849193957,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 155.52887849193957,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 1007.774,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                          {
                            lat: 24.999993,
                            lon: 121.008333,
                          },
                          {
                            lat: 25.0,
                            lon: 121.01,
                          },
                          {
                            lat: 25.000007,
                            lon: 121.011667,
                          },
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                        ],
                        vertexGapM: 1007.7682787413871,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 1007.7736890183071,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 43.545,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.015,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.01543209999998,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.015,
                          },
                          {
                            lat: 25.0,
                            lon: 121.01543209999998,
                          },
                        ],
                        vertexGapM: 43.545667332572556,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 43.545667332572556,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.01543209999998,
                        },
                        traversalTo: {
                          lat: 25.0001,
                          lon: 121.0154321,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 11.119492664568355,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
  disconnected: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          byteCount: 18686,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          graphByteCount: 18686,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
          layerReportSha256:
            "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
          declaredBuildPolicyJarSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          inputs: [
            {
              path: "build-config.json",
              role: "CONFIG",
              sha256:
                "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
              byteCount: 187,
            },
            {
              path: "fixture.gtfs.zip",
              role: "GTFS",
              sha256:
                "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
              byteCount: 1113,
            },
            {
              path: "merged.osm.pbf",
              role: "OSM",
              sha256:
                "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
              byteCount: 1215,
            },
            {
              path: "router-config.json",
              role: "CONFIG",
              sha256:
                "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
              byteCount: 1593,
            },
          ],
          compilerArtifacts: [
            {
              path: "build-ped-graph.py",
              role: "DEPENDENCY",
              sha256:
                "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
              byteCount: 74699,
            },
            {
              path: "osm-area-polygon-features.json",
              role: "DEPENDENCY",
              sha256:
                "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
              byteCount: 2753,
            },
            {
              path: "otp-sidewalk-layer.py",
              role: "COMPILER",
              sha256:
                "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
              byteCount: 102958,
            },
            {
              path: "otp-sidewalk-topology.py",
              role: "TOPOLOGY",
              sha256:
                "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
              byteCount: 7728,
            },
            {
              path: "ped-osm-areas.py",
              role: "DEPENDENCY",
              sha256:
                "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
              byteCount: 19272,
            },
            {
              path: "ped-sidewalk-network.py",
              role: "DEPENDENCY",
              sha256:
                "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
              byteCount: 56319,
            },
          ],
        },
        runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
        runtimePolicyIdentity: {
          status: "VERIFIED_OBSERVED_POLICY_CLASSES",
          reason: "TRUSTED_LAUNCHER_BOUNDARY",
          artifactSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          manifestSha256:
            "bccf6a39436903f7119ee185744001d59c43a6b3fc8f8c0a0eb41cf505c3e26f",
          observedClassDigestSha256:
            "92476a059bce2fd5bbd1a6f9e5b3e7d577eef0c7edc307fd006e815dd9fa66e2",
          classCount: 56,
        },
      },
      plan: {
        routingErrors: [],
        directWalkSearch: {
          schemaVersion: "1",
          status: "COMPLETED_NO_ROUTE",
          nativeOutcome: "EXHAUSTED",
          executedPolicy: {
            schemaVersion: "1",
            scope: "DIRECT_WALK_ONLY",
            profile: "NORMAL",
            wheelchairEnabled: false,
            walkSpeedMps: 1.3,
            stairsReluctance: 12.0,
            minimumKnownWidthM: null,
            maximumKnownNonStairSlopeRatio: null,
            fareAccess: "FORBID",
          },
          fromLat: 25.0,
          fromLon: 121.001,
          toLat: 25.01001,
          toLon: 121.0005,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [],
      },
    },
  },
  disconnected_wheelchair: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          byteCount: 18686,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "60ffe36718a870a4706a175cffd58514b843c00fff00f9a32fe23c1550884e0d",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "285d15cef67505d8cd29ccfa5da49da940c80a372c4dc88ea267e82700fa2944",
          graphByteCount: 18686,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
          layerReportSha256:
            "b2af961aec4fd16fe5e1526cda7e34e1495463aaea3a00524b0b3e02587f8502",
          declaredBuildPolicyJarSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          inputs: [
            {
              path: "build-config.json",
              role: "CONFIG",
              sha256:
                "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
              byteCount: 187,
            },
            {
              path: "fixture.gtfs.zip",
              role: "GTFS",
              sha256:
                "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
              byteCount: 1113,
            },
            {
              path: "merged.osm.pbf",
              role: "OSM",
              sha256:
                "250b6028341e1089668bde7650c046a81bb30ce0b951191cf0ed2cca52a9665e",
              byteCount: 1215,
            },
            {
              path: "router-config.json",
              role: "CONFIG",
              sha256:
                "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
              byteCount: 1593,
            },
          ],
          compilerArtifacts: [
            {
              path: "build-ped-graph.py",
              role: "DEPENDENCY",
              sha256:
                "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
              byteCount: 74699,
            },
            {
              path: "osm-area-polygon-features.json",
              role: "DEPENDENCY",
              sha256:
                "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
              byteCount: 2753,
            },
            {
              path: "otp-sidewalk-layer.py",
              role: "COMPILER",
              sha256:
                "aeeb0463ddeab77fc4252e30fbc8b5ccc5c9427244844a0a4078806a7e6d8df9",
              byteCount: 102958,
            },
            {
              path: "otp-sidewalk-topology.py",
              role: "TOPOLOGY",
              sha256:
                "8e73550643752a2a09d2217fab0962fca96e2e0c37b15e86019062e9f72f6af1",
              byteCount: 7728,
            },
            {
              path: "ped-osm-areas.py",
              role: "DEPENDENCY",
              sha256:
                "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
              byteCount: 19272,
            },
            {
              path: "ped-sidewalk-network.py",
              role: "DEPENDENCY",
              sha256:
                "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
              byteCount: 56319,
            },
          ],
        },
        runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
        runtimePolicyIdentity: {
          status: "VERIFIED_OBSERVED_POLICY_CLASSES",
          reason: "TRUSTED_LAUNCHER_BOUNDARY",
          artifactSha256:
            "5b7d5d2f576bcf25bc7f0a24c1ad26cbad7d72326e5f1c341b67da92146768b3",
          manifestSha256:
            "bccf6a39436903f7119ee185744001d59c43a6b3fc8f8c0a0eb41cf505c3e26f",
          observedClassDigestSha256:
            "92476a059bce2fd5bbd1a6f9e5b3e7d577eef0c7edc307fd006e815dd9fa66e2",
          classCount: 56,
        },
      },
      plan: {
        routingErrors: [],
        directWalkSearch: {
          schemaVersion: "1",
          status: "COMPLETED_NO_ROUTE",
          nativeOutcome: "EXHAUSTED",
          executedPolicy: {
            schemaVersion: "1",
            scope: "DIRECT_WALK_ONLY",
            profile: "WHEELCHAIR_STRICT",
            wheelchairEnabled: true,
            walkSpeedMps: 0.8,
            stairsReluctance: 12.0,
            minimumKnownWidthM: 0.9,
            maximumKnownNonStairSlopeRatio: 0.12,
            fareAccess: "FORBID",
          },
          fromLat: 25.0,
          fromLon: 121.001,
          toLat: 25.01001,
          toLon: 121.0005,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [],
      },
    },
  },
};
