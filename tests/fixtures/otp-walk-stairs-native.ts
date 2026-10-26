// Actual schema7 HTTP captures; controlled synthetic OSM stairs and isolated synthetic government surface.
// Built before capture with pinned compiler, input, package and graph manifest. Not national-source acceptance.
// Capture SHA256: d4d6507417620db9d59631d425c2dba165ecb7f9d4d75b7db09b6e8357a0e08c
export const otpWalkStairsNativeResponses = {
  stairs_strict: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
          fromLon: 121.0002,
          toLat: 25.0,
          toLon: 121.0028,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [],
      },
    },
  },
  stairs_assisted: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
            profile: "WHEELCHAIR_STAIRS_ASSISTED",
            wheelchairEnabled: true,
            walkSpeedMps: 0.8,
            stairsReluctance: 12.0,
            minimumKnownWidthM: 0.9,
            maximumKnownNonStairSlopeRatio: 0.12,
            fareAccess: "FORBID",
          },
          fromLat: 25.0,
          fromLon: 121.0002,
          toLat: 25.0,
          toLon: 121.0028,
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
                distance: 262.02,
                duration: 580.0,
                startTime: 1792980000000,
                endTime: 1792980580000,
                from: {
                  lat: 25.0,
                  lon: 121.0002,
                },
                to: {
                  lat: 25.0,
                  lon: 121.0028,
                },
                legGeometry: {
                  points: "_yqwCgzoaV?_D?gE?_D",
                },
                walkEvidence: {
                  schemaVersion: "7",
                  captureScope: "LEG_STATES_BACK_EDGES",
                  graphIdentityStatus: "VERIFIED_LOADED_BYTES",
                  executedPolicy: {
                    schemaVersion: "1",
                    scope: "DIRECT_WALK_ONLY",
                    profile: "WHEELCHAIR_STAIRS_ASSISTED",
                    wheelchairEnabled: true,
                    walkSpeedMps: 0.8,
                    stairsReluctance: 12.0,
                    minimumKnownWidthM: 0.9,
                    maximumKnownNonStairSlopeRatio: 0.12,
                    fareAccess: "FORBID",
                  },
                  graphByteIdentity: {
                    sha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    byteCount: 19105,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    graphByteCount: 19105,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                    layerReportSha256:
                      "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                          "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                        byteCount: 1165,
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
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "100",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "101",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: true,
                        escalator: false,
                        nativeWheelchairAccessible: false,
                        knownMaxSlopeRatio: null,
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: true,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 3,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "102",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                    geometryCoverageStatus: "NATIVE_GEOMETRY_COMPLETE",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    requestTo: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    startState: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    endState: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.0,
                    requestToToLastGeometryGapM: 0.0,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 262.0197525302358,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.001,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0002,
                          },
                          {
                            lat: 25.0,
                            lon: 121.001,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.001,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.001,
                          },
                          {
                            lat: 25.0,
                            lon: 121.002,
                          },
                        ],
                        vertexGapM: 100.77682789575329,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789575329,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.002,
                          },
                          {
                            lat: 25.0,
                            lon: 121.0028,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
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
  stairs_normal: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
          fromLat: 25.0,
          fromLon: 121.0002,
          toLat: 25.0,
          toLon: 121.0028,
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
                distance: 262.02,
                duration: 357.0,
                startTime: 1792980000000,
                endTime: 1792980357000,
                from: {
                  lat: 25.0,
                  lon: 121.0002,
                },
                to: {
                  lat: 25.0,
                  lon: 121.0028,
                },
                legGeometry: {
                  points: "_yqwCgzoaV?_D?gE?_D",
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
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    byteCount: 19105,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    graphByteCount: 19105,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                    layerReportSha256:
                      "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                          "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                        byteCount: 1165,
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
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "100",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "101",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: true,
                        escalator: false,
                        nativeWheelchairAccessible: false,
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
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "102",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                    geometryCoverageStatus: "NATIVE_GEOMETRY_COMPLETE",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    requestTo: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    startState: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    endState: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.0,
                    requestToToLastGeometryGapM: 0.0,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 262.0197525302358,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.001,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0002,
                          },
                          {
                            lat: 25.0,
                            lon: 121.001,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.001,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.001,
                          },
                          {
                            lat: 25.0,
                            lon: 121.002,
                          },
                        ],
                        vertexGapM: 100.77682789575329,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789575329,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.002,
                          },
                          {
                            lat: 25.0,
                            lon: 121.0028,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
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
  clear_strict: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
          fromLat: 25.0,
          fromLon: 121.0028,
          toLat: 25.0,
          toLon: 121.0058,
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
                distance: 302.33,
                duration: 378.0,
                startTime: 1792980000000,
                endTime: 1792980378000,
                from: {
                  lat: 25.0,
                  lon: 121.0028,
                },
                to: {
                  lat: 25.0,
                  lon: 121.0058,
                },
                legGeometry: {
                  points: "_yqwCojpaV?g@?gE?gE?_D",
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
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    byteCount: 19105,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    graphByteCount: 19105,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                    layerReportSha256:
                      "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                          "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                        byteCount: 1165,
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
                  edgeOccurrenceCount: 6,
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
                      distanceM: 20.155,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "102",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "103",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                      edgeKind: "StreetEdge",
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "104",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 4,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "105",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 5,
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
                    geometryCoverageStatus: "NATIVE_GEOMETRY_COMPLETE",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    requestTo: {
                      lat: 25.0,
                      lon: 121.0058,
                    },
                    startState: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    endState: {
                      lat: 25.0,
                      lon: 121.0058,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0058,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.0,
                    requestToToLastGeometryGapM: 0.0,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 302.33048369023373,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 20.155,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.003,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0028,
                          },
                          {
                            lat: 25.0,
                            lon: 121.003,
                          },
                        ],
                        vertexGapM: 20.155365580053797,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 20.155365580053797,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.003,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.004,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.003,
                          },
                          {
                            lat: 25.0,
                            lon: 121.004,
                          },
                        ],
                        vertexGapM: 100.77682789718538,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789718538,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.004,
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
                            lon: 121.004,
                          },
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                        ],
                        vertexGapM: 100.77682789575329,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789575329,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0058,
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
                            lon: 121.0058,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 5,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0058,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0058,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
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
  clear_strict_after_assisted: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
          fromLat: 25.0,
          fromLon: 121.0028,
          toLat: 25.0,
          toLon: 121.0058,
          departureTimeMs: 1792980580000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [
          {
            legs: [
              {
                mode: "WALK",
                distance: 302.33,
                duration: 378.0,
                startTime: 1792980580000,
                endTime: 1792980958000,
                from: {
                  lat: 25.0,
                  lon: 121.0028,
                },
                to: {
                  lat: 25.0,
                  lon: 121.0058,
                },
                legGeometry: {
                  points: "_yqwCojpaV?g@?gE?gE?_D",
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
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    byteCount: 19105,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    graphByteCount: 19105,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                    layerReportSha256:
                      "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                          "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                        byteCount: 1165,
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
                  edgeOccurrenceCount: 6,
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
                      distanceM: 20.155,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "102",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "103",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                      edgeKind: "StreetEdge",
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "104",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 4,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "105",
                      sourceSegmentIndex: 0,
                      reverse: false,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: false,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 5,
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
                    geometryCoverageStatus: "NATIVE_GEOMETRY_COMPLETE",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    requestTo: {
                      lat: 25.0,
                      lon: 121.0058,
                    },
                    startState: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    endState: {
                      lat: 25.0,
                      lon: 121.0058,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0058,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.0,
                    requestToToLastGeometryGapM: 0.0,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 302.33048369023373,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 20.155,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.003,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0028,
                          },
                          {
                            lat: 25.0,
                            lon: 121.003,
                          },
                        ],
                        vertexGapM: 20.155365580053797,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 20.155365580053797,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.003,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.004,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.003,
                          },
                          {
                            lat: 25.0,
                            lon: 121.004,
                          },
                        ],
                        vertexGapM: 100.77682789718538,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789718538,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.004,
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
                            lon: 121.004,
                          },
                          {
                            lat: 25.0,
                            lon: 121.005,
                          },
                        ],
                        vertexGapM: 100.77682789575329,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789575329,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.005,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0058,
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
                            lon: 121.0058,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 5,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0058,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0058,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
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
  stairs_reverse_strict: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
          fromLon: 121.0028,
          toLat: 25.0,
          toLon: 121.0002,
          departureTimeMs: 1792980000000,
          maximumSearchDurationS: 10800.0,
          streetSearchTimeoutS: 2.0,
          durationLimitPruned: false,
        },
        itineraries: [],
      },
    },
  },
  stairs_reverse_assisted: {
    data: {
      requestIdentity: {
        schemaVersion: "1",
        graphIdentityStatus: "VERIFIED_LOADED_BYTES",
        graphByteIdentity: {
          sha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          byteCount: 19105,
        },
        sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
        buildManifestIdentity: {
          manifestSha256:
            "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
          buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
          graphSha256:
            "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
          graphByteCount: 19105,
          sourceVersion: "fixture",
          sourceBatch: "fixture",
          sourceArchiveSha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          mergedPbfSha256:
            "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
          layerReportSha256:
            "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
              byteCount: 1165,
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
            profile: "WHEELCHAIR_STAIRS_ASSISTED",
            wheelchairEnabled: true,
            walkSpeedMps: 0.8,
            stairsReluctance: 12.0,
            minimumKnownWidthM: 0.9,
            maximumKnownNonStairSlopeRatio: 0.12,
            fareAccess: "FORBID",
          },
          fromLat: 25.0,
          fromLon: 121.0028,
          toLat: 25.0,
          toLon: 121.0002,
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
                distance: 262.02,
                duration: 580.0,
                startTime: 1792980000000,
                endTime: 1792980580000,
                from: {
                  lat: 25.0,
                  lon: 121.0028,
                },
                to: {
                  lat: 25.0,
                  lon: 121.0002,
                },
                legGeometry: {
                  points: "_yqwCojpaV?~C?fE?~C",
                },
                walkEvidence: {
                  schemaVersion: "7",
                  captureScope: "LEG_STATES_BACK_EDGES",
                  graphIdentityStatus: "VERIFIED_LOADED_BYTES",
                  executedPolicy: {
                    schemaVersion: "1",
                    scope: "DIRECT_WALK_ONLY",
                    profile: "WHEELCHAIR_STAIRS_ASSISTED",
                    wheelchairEnabled: true,
                    walkSpeedMps: 0.8,
                    stairsReluctance: 12.0,
                    minimumKnownWidthM: 0.9,
                    maximumKnownNonStairSlopeRatio: 0.12,
                    fareAccess: "FORBID",
                  },
                  graphByteIdentity: {
                    sha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    byteCount: 19105,
                  },
                  sourceManifestIdentityStatus:
                    "VERIFIED_TRUSTED_BUILD_MANIFEST",
                  runtimePolicyIdentityStatus:
                    "VERIFIED_OBSERVED_POLICY_CLASSES",
                  buildManifestIdentity: {
                    manifestSha256:
                      "42b126e511821b0e3b42b2df65dfc51b0335eab0a5d6faf54b3f06f9a669c3d4",
                    buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
                    graphSha256:
                      "7ce3cabd7e6074a40c75f3fcddc6660b3102d4b049dc137aa1f07393c2729d98",
                    graphByteCount: 19105,
                    sourceVersion: "fixture",
                    sourceBatch: "fixture",
                    sourceArchiveSha256:
                      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    mergedPbfSha256:
                      "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                    layerReportSha256:
                      "169e958f6bf0eb5d3fa15b9719575cce68901eb3f83dc12a59212e3bd7c43f86",
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
                          "4451fea90431d7391bd8a7daf3f635e5e7f0bb826d41dd87c09ceee3593a70b1",
                        byteCount: 1165,
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
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "102",
                      sourceSegmentIndex: 0,
                      reverse: true,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                      distanceM: 100.776,
                      metadataStatus: "OSM_WAY",
                      partial: false,
                      osmWayId: "101",
                      sourceSegmentIndex: 0,
                      reverse: true,
                      knownWidthM: 2.0,
                      sourceRefs: [],
                      widthSourceRefs: [],
                      sourceBatch: null,
                      sourceVersion: null,
                      sourceSha256: null,
                      unknownReason: null,
                      policyEvaluation: {
                        captureSchemaVersion: 2,
                        stairs: true,
                        escalator: false,
                        nativeWheelchairAccessible: false,
                        knownMaxSlopeRatio: null,
                        knownWidthM: 2.0,
                        knownSmoothness: null,
                        assistedStairs: true,
                      },
                      attachment: null,
                      areaSources: [],
                      pathway: null,
                    },
                    {
                      occurrenceIndex: 3,
                      edgeKind: "TemporaryPartialStreetEdge",
                      distanceM: 80.621,
                      metadataStatus: "OSM_WAY",
                      partial: true,
                      osmWayId: "100",
                      sourceSegmentIndex: 0,
                      reverse: true,
                      knownWidthM: 2.0,
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
                        knownWidthM: 2.0,
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
                    geometryCoverageStatus: "NATIVE_GEOMETRY_COMPLETE",
                    coordinateEncoding:
                      "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION",
                    gapMetric: "HAVERSINE_R6371000_METERS",
                    endpointReachabilityStatus: "NOT_PROVEN_BY_GEOMETRY",
                    startsSearchPath: true,
                    endsSearchPath: true,
                    requestFrom: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    requestTo: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    startState: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    endState: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    firstGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0028,
                    },
                    lastGeometryPoint: {
                      lat: 25.0,
                      lon: 121.0002,
                    },
                    requestFromToStartStateGapM: 0.0,
                    requestToToEndStateGapM: 0.0,
                    requestFromToFirstGeometryGapM: 0.0,
                    requestToToLastGeometryGapM: 0.0,
                    missingGeometryCount: 2,
                    positiveDistanceMissingGeometryCount: 0,
                    stateChainMismatchCount: 0,
                    representedGeometryLengthM: 262.0197525302358,
                    occurrences: [
                      {
                        occurrenceIndex: 0,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
                        geometryStartToTraversalFromGapM: null,
                        geometryEndToTraversalToGapM: null,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 0.0,
                      },
                      {
                        occurrenceIndex: 1,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0028,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.0028,
                          },
                          {
                            lat: 25.0,
                            lon: 121.002,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: null,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 2,
                        edgeKind: "StreetEdge",
                        distanceM: 100.776,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.001,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.002,
                          },
                          {
                            lat: 25.0,
                            lon: 121.001,
                          },
                        ],
                        vertexGapM: 100.77682789575329,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 100.77682789575329,
                      },
                      {
                        occurrenceIndex: 3,
                        edgeKind: "TemporaryPartialStreetEdge",
                        distanceM: 80.621,
                        partial: true,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.001,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "PRESENT",
                        geometrySource:
                          "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
                        coordinates: [
                          {
                            lat: 25.0,
                            lon: 121.001,
                          },
                          {
                            lat: 25.0,
                            lon: 121.0002,
                          },
                        ],
                        vertexGapM: 80.62146231724125,
                        geometryStartToTraversalFromGapM: 0.0,
                        geometryEndToTraversalToGapM: 0.0,
                        gapFromPreviousGeometryM: 0.0,
                        geometryLengthM: 80.62146231724125,
                      },
                      {
                        occurrenceIndex: 4,
                        edgeKind: "TemporaryFreeEdge",
                        distanceM: 0.0,
                        partial: false,
                        traversalFrom: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalTo: {
                          lat: 25.0,
                          lon: 121.0002,
                        },
                        traversalDirection: "EDGE_FORWARD",
                        geometryStatus: "NULL",
                        geometrySource: "NATIVE_EDGE_GET_GEOMETRY",
                        coordinates: [],
                        vertexGapM: 0.0,
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
};
