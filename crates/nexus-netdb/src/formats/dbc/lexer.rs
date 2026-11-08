/// Token types produced during lexical scanning of Vector .dbc files.
#[derive(Clone, Debug, PartialEq)]
pub enum Token {
    Word(String),
    QuotedString(String),
    Int(u64),
    Float(f64),
    Colon,
    Semicolon,
    Pipe,
    At,
    Comma,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Plus,
    Minus,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpannedToken {
    pub token: Token,
    pub line: usize,
    pub col: usize,
}

/// Fast lexical scanner for DBC source text.
pub struct DbcLexer<'a> {
    chars: std::str::Chars<'a>,
    peeked: Option<char>,
    line: usize,
    col: usize,
}

impl<'a> DbcLexer<'a> {
    pub fn new(input: &'a str) -> Self {
        Self {
            chars: input.chars(),
            peeked: None,
            line: 1,
            col: 0,
        }
    }

    fn next_char(&mut self) -> Option<char> {
        let ch = if let Some(p) = self.peeked.take() {
            Some(p)
        } else {
            self.chars.next()
        };

        if let Some(c) = ch {
            if c == '\n' {
                self.line += 1;
                self.col = 0;
            } else {
                self.col += 1;
            }
        }
        ch
    }

    fn peek_char(&mut self) -> Option<char> {
        if self.peeked.is_none() {
            self.peeked = self.chars.next();
        }
        self.peeked
    }

    pub fn tokenize(&mut self) -> Vec<SpannedToken> {
        let mut tokens = Vec::with_capacity(4096);

        while let Some(ch) = self.next_char() {
            let start_line = self.line;
            let start_col = self.col;

            // Skip whitespace
            if ch.is_whitespace() {
                continue;
            }

            // Single line comment //
            if ch == '/' && self.peek_char() == Some('/') {
                self.next_char();
                for next_c in self.by_ref() {
                    if next_c == '\n' {
                        break;
                    }
                }
                continue;
            }

            match ch {
                ':' => tokens.push(SpannedToken {
                    token: Token::Colon,
                    line: start_line,
                    col: start_col,
                }),
                ';' => tokens.push(SpannedToken {
                    token: Token::Semicolon,
                    line: start_line,
                    col: start_col,
                }),
                '|' => tokens.push(SpannedToken {
                    token: Token::Pipe,
                    line: start_line,
                    col: start_col,
                }),
                '@' => tokens.push(SpannedToken {
                    token: Token::At,
                    line: start_line,
                    col: start_col,
                }),
                ',' => tokens.push(SpannedToken {
                    token: Token::Comma,
                    line: start_line,
                    col: start_col,
                }),
                '(' => tokens.push(SpannedToken {
                    token: Token::LParen,
                    line: start_line,
                    col: start_col,
                }),
                ')' => tokens.push(SpannedToken {
                    token: Token::RParen,
                    line: start_line,
                    col: start_col,
                }),
                '[' => tokens.push(SpannedToken {
                    token: Token::LBracket,
                    line: start_line,
                    col: start_col,
                }),
                ']' => tokens.push(SpannedToken {
                    token: Token::RBracket,
                    line: start_line,
                    col: start_col,
                }),
                '+' => tokens.push(SpannedToken {
                    token: Token::Plus,
                    line: start_line,
                    col: start_col,
                }),
                '-' => tokens.push(SpannedToken {
                    token: Token::Minus,
                    line: start_line,
                    col: start_col,
                }),
                '"' => {
                    let s = self.scan_quoted_string();
                    tokens.push(SpannedToken {
                        token: Token::QuotedString(s),
                        line: start_line,
                        col: start_col,
                    });
                }
                '0'..='9' => {
                    let tok = self.scan_number(ch);
                    tokens.push(SpannedToken {
                        token: tok,
                        line: start_line,
                        col: start_col,
                    });
                }
                _ => {
                    let word = self.scan_word(ch);
                    tokens.push(SpannedToken {
                        token: Token::Word(word),
                        line: start_line,
                        col: start_col,
                    });
                }
            }
        }

        tokens
    }

    fn scan_quoted_string(&mut self) -> String {
        let mut result = String::with_capacity(32);
        while let Some(ch) = self.next_char() {
            if ch == '"' {
                // Check if escaped "" Vector DBC convention or standard quote
                if self.peek_char() == Some('"') {
                    self.next_char();
                    result.push('"');
                } else {
                    break;
                }
            } else if ch == '\\' {
                if let Some(escaped) = self.next_char() {
                    match escaped {
                        '"' => result.push('"'),
                        '\\' => result.push('\\'),
                        'n' => result.push('\n'),
                        'r' => result.push('\r'),
                        't' => result.push('\t'),
                        other => {
                            result.push('\\');
                            result.push(other);
                        }
                    }
                }
            } else {
                result.push(ch);
            }
        }
        result
    }

    fn scan_number(&mut self, first_char: char) -> Token {
        let mut buf = String::with_capacity(24);
        buf.push(first_char);

        // Check for hex literal e.g. 0x100
        if first_char == '0' && (self.peek_char() == Some('x') || self.peek_char() == Some('X')) {
            buf.push(self.next_char().unwrap_or('x'));
            while let Some(ch) = self.peek_char() {
                if ch.is_ascii_hexdigit() {
                    buf.push(self.next_char().unwrap_or(ch));
                } else {
                    break;
                }
            }
            if let Ok(val) = u64::from_str_radix(&buf[2..], 16) {
                return Token::Int(val);
            }
            return Token::Word(buf);
        }

        let mut is_float = false;

        while let Some(ch) = self.peek_char() {
            if ch.is_ascii_digit() {
                buf.push(self.next_char().unwrap_or(ch));
            } else if ch == '.' {
                // Only consider decimal point if followed by a digit
                // (e.g. not .. or method call)
                is_float = true;
                buf.push(self.next_char().unwrap_or(ch));
            } else if (ch == 'e' || ch == 'E') && !buf.is_empty() {
                is_float = true;
                buf.push(self.next_char().unwrap_or(ch));
                if let Some(sign) = self.peek_char() {
                    if sign == '+' || sign == '-' {
                        buf.push(self.next_char().unwrap_or(sign));
                    }
                }
            } else {
                break;
            }
        }

        if is_float {
            if let Ok(f) = buf.parse::<f64>() {
                return Token::Float(f);
            }
        } else if let Ok(i) = buf.parse::<u64>() {
            return Token::Int(i);
        }

        Token::Word(buf)
    }

    fn scan_word(&mut self, first_char: char) -> String {
        let mut buf = String::with_capacity(32);
        buf.push(first_char);

        while let Some(ch) = self.peek_char() {
            if ch.is_whitespace()
                || ch == ':'
                || ch == ';'
                || ch == '|'
                || ch == '@'
                || ch == ','
                || ch == '('
                || ch == ')'
                || ch == '['
                || ch == ']'
                || ch == '"'
            {
                break;
            }
            buf.push(self.next_char().unwrap_or(ch));
        }

        buf
    }
}

impl<'a> Iterator for DbcLexer<'a> {
    type Item = char;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_char()
    }
}
