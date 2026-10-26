package org.opentripplanner.astar;
/** Actual exit branch of the native A* loop; optional observer does not alter the search. */
public enum SearchCompletion { TARGET_REACHED, EXHAUSTED, TIMEOUT, TERMINATED, ERROR }
