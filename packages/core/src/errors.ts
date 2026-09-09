/** Input could not be parsed as a QuickTime/ISO BMFF file. */
export class MovParseError extends Error {
  override name = 'MovParseError'
}

/** The file was parsed but contains something this library cannot convert (yet). */
export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError'
}

/** A conversion that should have been possible failed midway. */
export class ConversionError extends Error {
  override name = 'ConversionError'
}
